#!/usr/bin/env node
/*
 * LocalFront — a local, CloudFront-like CDN emulator that fronts MinIO (or any HTTP origin).
 *
 *   - Distributions with CloudFront-style IDs (E + 13 chars) and a domain <id>.localhost
 *   - Each distribution points at an origin (e.g. MinIO http://localhost:9000) + origin path (bucket)
 *   - Edge-style caching: min/default/max TTL, honors origin Cache-Control / Expires
 *   - Conditional revalidation (ETag / Last-Modified) on stale objects
 *   - On-the-fly gzip/br compression, cache-key by path (+ optional query / headers)
 *   - Invalidations by path pattern (/*, /img/*, exact)
 *   - CloudFront-ish response headers: X-Cache, Age, Via, X-Amz-Cf-Pop, X-Amz-Cf-Id
 *   - Admin API + CLI (create/list/get/update/delete distributions, invalidations, stats)
 *
 * Runs on localhost only. Zero dependencies. Node >= 18 (tested on 22).
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.LOCALFRONT_CONFIG || path.resolve(process.cwd(), 'distributions.json');
const PROXY_PORT = parseInt(process.env.LOCALFRONT_PORT || '8080', 10);
const ADMIN_PORT = parseInt(process.env.LOCALFRONT_ADMIN_PORT || '5744', 10);
const CACHE_MAX = parseInt(process.env.LOCALFRONT_CACHE_MAX || '5000', 10);

const CACHEABLE_STATUS = new Set([200, 203, 204, 301, 302, 307, 308, 404, 410]);
const COMPRESSIBLE = [
  'text/', 'application/json', 'application/javascript', 'application/xml',
  'application/x-javascript', 'image/svg+xml', 'application/manifest+json',
  'application/vnd.api+json', 'application/rss+xml',
];

// ----------------------------------------------------------------------------- helpers
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, d) => (v === undefined || v === null || isNaN(+v) ? d : +v);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function genId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const b = randomBytes(13);
  let s = 'E';
  for (let i = 0; i < 13; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}

function isCompressible(ct = '') {
  ct = ct.toLowerCase();
  return COMPRESSIBLE.some((p) => ct.startsWith(p) || ct.includes(p));
}

function parseCacheControl(cc) {
  const out = {};
  if (!cc) return out;
  for (const part of String(cc).split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k.toLowerCase()] = v === undefined ? true : v;
  }
  return out;
}

function headersToObj(h) {
  const o = {};
  for (const [k, v] of h.entries()) o[k.toLowerCase()] = v;
  return o;
}

function mergeVary(existing, add) {
  const set = new Set(
    (existing ? String(existing).split(',') : []).map((s) => s.trim()).filter(Boolean)
  );
  set.add(add);
  return [...set].join(', ');
}

function matchPath(pattern, objPath) {
  if (!pattern.startsWith('/')) pattern = '/' + pattern;
  const re = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(objPath);
}

// ----------------------------------------------------------------------------- config
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { distributions: [] };
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(c.distributions)) c.distributions = [];
    return c;
  } catch (e) {
    console.error(`[localfront] failed to parse ${CONFIG_PATH}: ${e.message}`);
    return { distributions: [] };
  }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function normalizeOriginPath(value) {
  let originPath = String(value || '').trim().replaceAll('\\', '/');
  // Git Bash rewrites CLI values such as /assets to <git-install>/assets on Windows.
  const gitRoot = originPath.match(/^\w:\/[^/]+\/Git\/(.*)$/i);
  if (gitRoot) originPath = gitRoot[1];
  if (/^\w:\//.test(originPath)) {
    throw new Error(`origin-path must be a URL path such as /assets, not a filesystem path: ${value}`);
  }
  if (!originPath) return '';
  return '/' + originPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeDistribution(input) {
  if (!input.origin || !input.origin.domainName) {
    throw new Error('origin.domainName is required (e.g. http://localhost:9000)');
  }
  const id = input.id || genId();
  const b = input.defaultCacheBehavior || {};
  return {
    id,
    comment: input.comment || '',
    enabled: input.enabled !== false,
    domainName: input.domainName || `${id.toLowerCase()}.localhost`,
    origin: {
      domainName: String(input.origin.domainName).replace(/\/+$/, ''),
      originPath: normalizeOriginPath(input.origin.originPath),
      customHeaders: input.origin.customHeaders || {},
    },
    defaultCacheBehavior: {
      minTtl: num(b.minTtl, 0),
      defaultTtl: num(b.defaultTtl, 86400),
      maxTtl: num(b.maxTtl, 31536000),
      compress: b.compress !== false,
      forwardQueryString: !!b.forwardQueryString,
      cachedMethods: b.cachedMethods || ['GET', 'HEAD'],
      cacheKeyHeaders: b.cacheKeyHeaders || [],
    },
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------- cache
class Cache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    this.map.delete(key);
    this.map.set(key, e); // LRU touch
    return e;
  }
  set(key, entry) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  invalidate(distId, patterns) {
    let count = 0;
    for (const key of [...this.map.keys()]) {
      if (!key.startsWith(distId + '::')) continue;
      const objPath = key.split('::')[2] || '';
      const bare = objPath.split('?')[0].split('#')[0];
      if (patterns.some((p) => matchPath(p, bare))) {
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }
  size() {
    return this.map.size;
  }
}

function cacheKey(dist, req, urlObj) {
  const b = dist.defaultCacheBehavior;
  let key = urlObj.pathname;
  if (b.forwardQueryString) {
    const params = [...urlObj.searchParams.entries()].sort();
    if (params.length) key += '?' + params.map(([k, v]) => `${k}=${v}`).join('&');
  }
  if (b.cacheKeyHeaders && b.cacheKeyHeaders.length) {
    key += '#' + b.cacheKeyHeaders.map((h) => `${h}=${req.headers[h.toLowerCase()] || ''}`).join('|');
  }
  return `${dist.id}::${req.method}::${key}`;
}

function computeTtl(behavior, resHeaders) {
  const cc = parseCacheControl(resHeaders['cache-control']);
  if (cc['no-store'] || cc['private']) return { cacheable: false, ttl: 0 };
  let originTtl = null;
  if (cc['s-maxage'] !== undefined) originTtl = parseInt(cc['s-maxage'], 10);
  else if (cc['max-age'] !== undefined) originTtl = parseInt(cc['max-age'], 10);
  else if (resHeaders['expires']) {
    const exp = Date.parse(resHeaders['expires']);
    if (!isNaN(exp)) originTtl = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  }
  let ttl;
  if (originTtl != null && !isNaN(originTtl)) ttl = clamp(originTtl, behavior.minTtl, behavior.maxTtl);
  else ttl = clamp(behavior.defaultTtl, behavior.minTtl, behavior.maxTtl);
  return { cacheable: true, ttl };
}

// ----------------------------------------------------------------------------- routing
function resolveDistribution(req, dists) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const firstLabel = host.split('.')[0];
  let d = dists.find((x) => x.id.toLowerCase() === firstLabel || x.domainName.toLowerCase() === host);
  if (d) return d;

  const hid = (req.headers['x-distribution-id'] || '').toLowerCase();
  if (hid) {
    d = dists.find((x) => x.id.toLowerCase() === hid);
    if (d) return d;
  }

  const m = (req.url || '').match(/^\/_d\/([^/]+)\//i);
  if (m) {
    d = dists.find((x) => x.id.toLowerCase() === m[1].toLowerCase());
    if (d) return d;
  }

  const enabled = dists.filter((x) => x.enabled);
  if (enabled.length === 1) return enabled[0];
  return null;
}

// ----------------------------------------------------------------------------- proxy
function buildForwardHeaders(req, dist, cached) {
  const h = {};
  const pass = ['accept', 'accept-language', 'range', 'user-agent'];
  for (const k of pass) if (req.headers[k]) h[k] = req.headers[k];
  Object.assign(h, dist.origin.customHeaders || {});
  if (cached) {
    if (cached.etag) h['if-none-match'] = cached.etag;
    if (cached.lastModified) h['if-modified-since'] = cached.lastModified;
  } else {
    if (req.headers['if-none-match']) h['if-none-match'] = req.headers['if-none-match'];
    if (req.headers['if-modified-since']) h['if-modified-since'] = req.headers['if-modified-since'];
  }
  return h;
}

async function deliver(res, req, dist, entry, cacheStatus, metrics) {
  const headers = { ...entry.headers };
  for (const h of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']) {
    delete headers[h];
  }

  let body = entry.body || Buffer.alloc(0);
  const b = dist.defaultCacheBehavior;
  const ae = req.headers['accept-encoding'] || '';
  const isHead = req.method === 'HEAD';
  const noBody = isHead || entry.status === 204 || entry.status === 304;

  if (b.compress && !noBody && body.length > 0 && isCompressible(headers['content-type'])) {
    if (/\bbr\b/.test(ae)) {
      body = await brotli(body);
      headers['content-encoding'] = 'br';
    } else if (/\bgzip\b/.test(ae)) {
      body = await gzip(body);
      headers['content-encoding'] = 'gzip';
    }
    if (headers['content-encoding']) headers['vary'] = mergeVary(headers['vary'], 'Accept-Encoding');
  }

  if (!noBody) headers['content-length'] = String(body.length);

  const now = Date.now();
  const age = Math.max(0, Math.floor((now - entry.storedAt) / 1000));
  headers['x-cache'] = `${cacheStatus} from LocalFront`;
  if (cacheStatus !== 'Miss') headers['age'] = String(age);
  headers['via'] = `1.1 ${dist.id.toLowerCase()}.localfront (LocalFront)`;
  headers['x-amz-cf-pop'] = 'LOCAL1-C1';
  headers['x-amz-cf-id'] = randomBytes(24).toString('base64url');
  headers['x-localfront-dist'] = dist.id;

  // metrics
  metrics.requests++;
  if (cacheStatus === 'Hit') metrics.hits++;
  else if (cacheStatus === 'RefreshHit') metrics.refreshHits++;
  else metrics.misses++;

  res.writeHead(entry.status, headers);
  if (noBody) res.end();
  else res.end(body);
}

async function handleProxy(req, res, state) {
  const dist = resolveDistribution(req, state.config.distributions);
  if (!dist) {
    return sendPlain(res, 404,
      'LocalFront: no matching distribution.\n' +
      'Route via <id>.localhost, header "X-Distribution-Id: <id>", or path /_d/<id>/...\n');
  }
  if (!dist.enabled) return sendPlain(res, 403, `LocalFront: distribution ${dist.id} is disabled.\n`);

  // strip /_d/<id> path prefix if used
  let rawUrl = req.url;
  const prefix = `/_d/${dist.id}/`;
  if (rawUrl.toLowerCase().startsWith(prefix.toLowerCase())) rawUrl = '/' + rawUrl.slice(prefix.length);

  const urlObj = new URL(rawUrl, 'http://localhost');
  const b = dist.defaultCacheBehavior;
  const method = req.method;
  const cacheableMethod = b.cachedMethods.includes(method);
  const hasRange = !!req.headers['range'];
  const key = cacheKey(dist, req, urlObj);
  const now = Date.now();

  // fresh cache hit
  let cached = cacheableMethod && !hasRange ? state.cache.get(key) : null;
  if (cached && now < cached.expiresAt) {
    return deliver(res, req, dist, cached, 'Hit', state.metrics);
  }

  // fetch from origin (conditional revalidation if we hold a stale entry)
  const isRevalidation = !!cached;
  const originUrl = dist.origin.domainName + dist.origin.originPath + urlObj.pathname + urlObj.search;
  const fwd = buildForwardHeaders(req, dist, cached);
  let originRes;
  try {
    originRes = await fetch(originUrl, { method, headers: fwd, redirect: 'manual' });
  } catch (e) {
    if (isRevalidation) {
      recordRevalidation(state, { distribution: dist.id, method, path: urlObj.pathname, origin: originUrl, status: 'error', result: 'failed' });
    }
    return sendPlain(res, 502, `LocalFront: origin fetch failed (${originUrl}): ${e.message}\n`);
  }

  // stale-but-valid: origin says 304 -> refresh TTL, serve cached body
  if (cached && originRes.status === 304) {
    const rh = headersToObj(originRes.headers);
    const { ttl } = computeTtl(b, rh);
    cached.storedAt = now;
    cached.expiresAt = now + ttl * 1000;
    state.cache.set(key, cached);
    recordRevalidation(state, {
      distribution: dist.id,
      method,
      path: urlObj.pathname,
      origin: originUrl,
      status: 304,
      result: 'not-modified',
      ttl,
    });
    return deliver(res, req, dist, cached, 'RefreshHit', state.metrics);
  }

  const bodyBuf = Buffer.from(await originRes.arrayBuffer());
  const resHeaders = headersToObj(originRes.headers);
  // we hold the decoded buffer; manage encoding/length ourselves downstream
  delete resHeaders['content-encoding'];
  delete resHeaders['content-length'];

  const status = originRes.status;
  const { cacheable, ttl } = computeTtl(b, resHeaders);
  const shouldStore =
    cacheableMethod && !hasRange && cacheable && ttl > 0 && CACHEABLE_STATUS.has(status);

  const entry = {
    status,
    headers: resHeaders,
    body: bodyBuf,
    storedAt: now,
    expiresAt: now + (shouldStore ? ttl : 0) * 1000,
    etag: resHeaders['etag'],
    lastModified: resHeaders['last-modified'],
  };
  if (shouldStore) state.cache.set(key, entry);

  if (isRevalidation) {
    recordRevalidation(state, {
      distribution: dist.id,
      method,
      path: urlObj.pathname,
      origin: originUrl,
      status,
      result: 'updated',
      ttl: shouldStore ? ttl : 0,
    });
  }

  return deliver(res, req, dist, entry, 'Miss', state.metrics);
}

// ----------------------------------------------------------------------------- admin API
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function sendHtml(res, code, html) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}
function sendCss(res, code, css) {
  res.writeHead(code, {
    'content-type': 'text/css; charset=utf-8',
    'content-length': Buffer.byteLength(css),
  });
  res.end(css);
}
function sendPlain(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function recordRevalidation(state, event) {
  const item = { id: 'R' + genId().slice(1), timestamp: new Date().toISOString(), ...event };
  state.revalidations.unshift(item);
  if (state.revalidations.length > 100) state.revalidations.length = 100;
  console.log(`[revalidate] ${item.distribution} ${item.method} ${item.path} -> ${item.status} ${item.result}${item.ttl === undefined ? '' : ` ttl=${item.ttl}s`}`);
}

async function handleAdmin(req, res, state) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (url.pathname === '/' && method === 'GET') {
    return sendHtml(res, 200, adminDashboardHtml());
  }
  if (url.pathname === '/style.css' && method === 'GET') {
    const cssPath = path.join(APP_ROOT, 'style.css');
    if (!existsSync(cssPath)) return sendPlain(res, 404, 'style.css not found\n');
    return sendCss(res, 200, readFileSync(cssPath, 'utf8'));
  }
  const brandAssets = {
    '/favicon.ico': ['assets/cowfront-logo/favicon/favicon.ico', 'image/x-icon'],
    '/apple-touch-icon.png': ['assets/cowfront-logo/favicon/apple-touch-icon.png', 'image/png'],
    '/cowfront-logo.png': ['assets/cowfront-logo/cowfront-horizontal.png', 'image/png'],
  };
  if (method === 'GET' && brandAssets[url.pathname]) {
    const [asset, contentType] = brandAssets[url.pathname];
    const assetPath = path.join(APP_ROOT, asset);
    if (!existsSync(assetPath)) return sendPlain(res, 404, 'brand asset not found\n');
    const body = readFileSync(assetPath);
    res.writeHead(200, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
    return res.end(body);
  }

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, service: 'localfront' });

  if (url.pathname === '/stats') {
    return sendJson(res, 200, {
      cacheEntries: state.cache.size(),
      cacheMax: state.cache.max,
      distributions: state.config.distributions.length,
      ...state.metrics,
    });
  }

  if (url.pathname === '/revalidations' && method === 'GET') {
    return sendJson(res, 200, { revalidations: state.revalidations });
  }

  if (parts[0] === 'distributions') {
    const id = parts[1];

    if (!id && method === 'GET') {
      return sendJson(res, 200, { distributions: state.config.distributions });
    }
    if (!id && method === 'POST') {
      const body = await readBody(req);
      const dist = normalizeDistribution(body);
      state.config.distributions.push(dist);
      persist(state);
      return sendJson(res, 201, dist);
    }
    if (id) {
      const idx = state.config.distributions.findIndex((d) => d.id.toLowerCase() === id.toLowerCase());
      if (idx === -1) return sendJson(res, 404, { error: `distribution ${id} not found` });

      if (method === 'GET') return sendJson(res, 200, state.config.distributions[idx]);

      if (method === 'PUT') {
        const body = await readBody(req);
        const merged = normalizeDistribution({ ...state.config.distributions[idx], ...body, id: state.config.distributions[idx].id });
        state.config.distributions[idx] = merged;
        persist(state);
        return sendJson(res, 200, merged);
      }
      if (method === 'DELETE') {
        const [removed] = state.config.distributions.splice(idx, 1);
        state.cache.invalidate(removed.id, ['/*']);
        persist(state);
        return sendJson(res, 200, { deleted: removed.id });
      }
      if (method === 'POST' && parts[2] === 'invalidations') {
        const body = await readBody(req);
        const paths = body.paths && body.paths.length ? body.paths : ['/*'];
        const count = state.cache.invalidate(state.config.distributions[idx].id, paths);
        recordRevalidation(state, {
          distribution: state.config.distributions[idx].id,
          method: 'PURGE',
          path: paths.join(', '),
          origin: '',
          status: count,
          result: 'invalidated',
        });
        return sendJson(res, 201, { id: 'I' + genId().slice(1), distribution: state.config.distributions[idx].id, paths, invalidated: count });
      }
    }
  }

  return sendJson(res, 404, { error: 'not found', hint: 'GET /distributions, POST /distributions, /stats, /health' });
}

function adminDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CowFront Admin</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="stylesheet" href="/style.css" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #08111f;
      --bg2: #0d1a31;
      --panel: rgba(12, 20, 38, 0.82);
      --panel-strong: rgba(18, 29, 52, 0.96);
      --line: rgba(153, 180, 255, 0.16);
      --text: #eaf1ff;
      --muted: #9eb0d4;
      --accent: #72d6ff;
      --accent-2: #8b7bff;
      --good: #5ce3b0;
      --warn: #ffd48c;
      --bad: #ff8ca1;
      --shadow: 0 24px 90px rgba(0, 0, 0, 0.4);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 15% 10%, rgba(114, 214, 255, 0.18), transparent 30%),
        radial-gradient(circle at 85% 0%, rgba(139, 123, 255, 0.18), transparent 28%),
        linear-gradient(180deg, var(--bg), var(--bg2));
    }
    .wrap {
      width: min(1200px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    .hero {
      display: grid;
      gap: 18px;
      grid-template-columns: 1.5fr 0.9fr;
      align-items: end;
      margin-bottom: 18px;
    }
    .title {
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(20, 31, 57, 0.95), rgba(12, 20, 38, 0.86));
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 12px;
      font-weight: 700;
    }
    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--good);
      box-shadow: 0 0 18px var(--good);
    }
    h1 {
      margin: 12px 0 10px;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 0.98;
      letter-spacing: -0.04em;
    }
    .sub {
      margin: 0;
      max-width: 68ch;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.6;
    }
    .statusbar {
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .status-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 8px;
    }
    .status-value {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 10px;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 18px 0;
    }
    button, .ghost, input, textarea {
      font: inherit;
    }
    button, .ghost {
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 11px 14px;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    button:hover, .ghost:hover { transform: translateY(-1px); }
    button.primary {
      color: #07111f;
      background: linear-gradient(135deg, var(--accent), #9df0ff);
      font-weight: 800;
    }
    button.secondary, .ghost {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
      border-color: var(--line);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
      overflow: hidden;
    }
    .panel h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 20px 22px 0;
    }
    .panel-body { padding: 18px 22px 22px; }
    .stats { grid-column: span 12; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      padding-top: 18px;
    }
    .card {
      padding: 16px;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      border: 1px solid rgba(255,255,255,0.06);
    }
    .card .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .card .value {
      margin-top: 10px;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .layout-left { grid-column: span 7; }
    .layout-right { grid-column: span 5; }
    .table {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .dist {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255,255,255,0.035);
      border: 1px solid rgba(255,255,255,0.06);
      display: grid;
      gap: 12px;
    }
    .dist-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      align-items: start;
    }
    .dist-id {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .chip.good { color: var(--good); }
    .chip.bad { color: var(--bad); }
    .meta {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    form {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .field-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    input, textarea {
      width: 100%;
      color: var(--text);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 14px;
      padding: 11px 12px;
      outline: none;
    }
    textarea { min-height: 88px; resize: vertical; }
    input:focus, textarea:focus {
      border-color: rgba(114, 214, 255, 0.48);
      box-shadow: 0 0 0 4px rgba(114, 214, 255, 0.12);
    }
    .checks {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      color: var(--text);
      font-size: 14px;
    }
    .checks label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-size: 14px;
    }
    .checks input { width: auto; }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .empty {
      padding: 24px;
      border-radius: 18px;
      border: 1px dashed rgba(255,255,255,0.12);
      color: var(--muted);
      text-align: center;
    }
    .footer-note {
      margin-top: 18px;
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 980px) {
      .hero, .layout-left, .layout-right, .stats-grid, .field-row {
        grid-template-columns: 1fr;
      }
      .hero { grid-template-columns: 1fr; }
      .layout-left, .layout-right, .stats { grid-column: span 12; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 720px) {
      .wrap { width: min(100vw - 20px, 1200px); padding-top: 10px; }
      .title, .statusbar, .panel { border-radius: 18px; }
      .stats-grid { grid-template-columns: 1fr; }
      .panel-head, .panel-body { padding-left: 16px; padding-right: 16px; }
      .actions, .toolbar { flex-direction: column; align-items: stretch; }
      button, .ghost { width: 100%; justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="top-grid">
    <section class="hero">
      <div class="title">
        <div class="brand-lockup">
          <img src="/cowfront-logo.png" alt="CowFront" />
        </div>
        <div class="eyebrow">CowFront Admin</div>
        <h1>Control your local CDN from one small dashboard.</h1>
        <p class="sub">
          Create distributions, watch cache health, and invalidate objects without leaving the browser.
          Everything here talks to the admin API on port ${ADMIN_PORT}, while the proxy stays on port ${PROXY_PORT}.
        </p>
        <div class="toolbar">
          <button class="primary" id="refreshBtn">Refresh data</button>
          <button class="secondary" id="copyApiBtn">Copy admin URL</button>
        </div>
      </div>
    </section>

    <section class="panel stats">
      <div class="panel-head">
        <h2>Overview</h2>
        <div class="hint" id="updatedAt">Not loaded yet</div>
      </div>
      <div class="overview-status">
        <div class="status-label">Service status</div>
        <div class="status-value" id="healthLine">Checking...</div>
        <div class="hint" id="healthHint">Loading the admin API and current stats.</div>
      </div>
      <div class="panel-body">
        <div class="stats-grid" id="statsGrid"></div>
      </div>
    </section>
    </section>

    <section class="grid workspace-grid" style="margin-top:16px;">
      <section class="panel layout-right list-panel">
        <div class="panel-head">
          <h2>Distributions</h2>
          <div class="hint" id="distCount">0 total</div>
        </div>
        <div class="panel-body">
          <div class="table" id="distributionList"></div>
        </div>
      </section>

      <section class="panel layout-left create-panel">
        <div class="panel-head">
          <h2>Create distribution</h2>
          <div class="hint">POST /distributions</div>
        </div>
        <div class="panel-body">
          <form id="createForm">
            <div class="field-row">
              <label>Origin URL
                <input name="origin" placeholder="http://localhost:9000" required />
              </label>
              <label>Origin path
                <input name="origin-path" placeholder="/assets" />
              </label>
            </div>
            <label>Friendly hostname
              <input name="domain" placeholder="site.local (optional)" />
            </label>
            <div class="field-row">
              <label>Default TTL
                <input name="default-ttl" type="number" min="0" placeholder="86400" />
              </label>
              <label>Min TTL
                <input name="min-ttl" type="number" min="0" placeholder="0" />
              </label>
            </div>
            <div class="field-row">
              <label>Max TTL
                <input name="max-ttl" type="number" min="0" placeholder="31536000" />
              </label>
              <label>Distribution ID
                <input name="id" placeholder="optional" />
              </label>
            </div>
            <label>Comment
              <textarea name="comment" placeholder="Optional note for this distribution"></textarea>
            </label>
            <div class="checks">
              <label><input name="compress" type="checkbox" checked /> Compress objects</label>
              <label><input name="forward-query" type="checkbox" /> Forward query string</label>
            </div>
            <button class="primary" type="submit">Create distribution</button>
            <div class="hint">A distribution ID is generated automatically unless you provide one.</div>
          </form>
        </div>
      </section>

      <section class="panel layout-left invalidate-panel">
        <div class="panel-head">
          <h2>Invalidate cache</h2>
          <div class="hint">POST /distributions/:id/invalidations</div>
        </div>
        <div class="panel-body">
          <form id="invalidationForm">
            <div class="field-row">
              <label>Distribution ID
                <input name="distribution" placeholder="E1A2B3C4D5E6F7" required />
              </label>
              <label>Paths
                <input name="paths" placeholder="/*, /img/*" />
              </label>
            </div>
            <button class="primary" type="submit">Invalidate</button>
            <div class="hint">Separate multiple invalidation paths with commas.</div>
          </form>
        </div>
      </section>
    </section>
    <section class="panel revalidation-panel">
      <div class="panel-head">
        <h2>Revalidation history</h2>
        <div class="hint">latest 100 checks</div>
      </div>
      <div class="panel-body">
        <div class="history-table" id="revalidationList"></div>
      </div>
    </section>
    <div class="footer-note">
      CowFront admin console. The proxy endpoint remains available on port ${PROXY_PORT}.
    </div>
  </div>

  <script>
    const proxyPort = ${PROXY_PORT};
    const adminPort = ${ADMIN_PORT};
    const el = (sel) => document.querySelector(sel);

    const state = { distributions: [], revalidations: [], stats: {}, health: null };

    function fmtTime(ts) {
      return new Date(ts).toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
    }

    function statCard(label, value) {
      return \`
        <div class="card">
          <div class="label">\${label}</div>
          <div class="value">\${value}</div>
        </div>
      \`;
    }

    function copy(text) {
      return navigator.clipboard.writeText(text);
    }

    function render() {
      const stats = state.stats || {};
      const hits = Number(stats.hits || 0);
      const misses = Number(stats.misses || 0);
      const refreshHits = Number(stats.refreshHits || 0);
      const requests = Number(stats.requests || 0);
      const hitRate = requests ? Math.round(((hits + refreshHits) / requests) * 100) : 0;

      el('#statsGrid').innerHTML = [
        statCard('Requests', requests.toLocaleString()),
        statCard('Cache entries', Number(stats.cacheEntries || 0).toLocaleString()),
        statCard('Hit rate', hitRate + '%'),
        statCard('Distributions', Number(stats.distributions || state.distributions.length || 0).toLocaleString())
      ].join('');

      el('#distCount').textContent = state.distributions.length + ' total';

      if (!state.distributions.length) {
        el('#distributionList').innerHTML = '<div class="empty">No distributions yet. Use the form on the right to create the first one.</div>';
      } else {
        el('#distributionList').innerHTML = state.distributions.map((d) => {
          const enabled = d.enabled !== false;
          const proxyUrl = 'http://' + d.domainName + ':' + proxyPort + '/';
          const originUrl = d.origin.domainName + (d.origin.originPath || '');
          const ttl = [d.defaultCacheBehavior.minTtl, d.defaultCacheBehavior.defaultTtl, d.defaultCacheBehavior.maxTtl].join(' / ');
          return \`
            <article class="dist">
              <div class="dist-top">
                <div>
                  <div class="dist-id">\${d.id}</div>
                  <div class="meta">
                    <div><strong>Domain</strong> <a href="\${proxyUrl}" target="_blank" rel="noreferrer">\${proxyUrl}</a></div>
                    <div><strong>Origin</strong> \${originUrl}</div>
                    <div><strong>TTL</strong> min / default / max = \${ttl}</div>
                  </div>
                </div>
                <div class="chip \${enabled ? 'good' : 'bad'}">\${enabled ? 'Enabled' : 'Disabled'}</div>
              </div>
              <div class="meta">
                <div><strong>Comment</strong> \${d.comment || '—'}</div>
                <div><strong>Created</strong> \${fmtTime(d.createdAt)}</div>
              </div>
              <div class="actions">
                <button class="ghost" data-copy="\${d.id}">Copy ID</button>
                <button class="ghost" data-proxy="\${d.id}">Copy proxy URL</button>
                <button class="ghost" data-invalidate="\${d.id}">Invalidate /*</button>
                <button class="ghost" data-delete="\${d.id}">Delete</button>
              </div>
            </article>
          \`;
        }).join('');

        el('#distributionList').querySelectorAll('[data-copy]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await copy(btn.dataset.copy);
            btn.textContent = 'Copied';
            setTimeout(() => (btn.textContent = 'Copy ID'), 900);
          });
        });
        el('#distributionList').querySelectorAll('[data-proxy]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.proxy;
            const d = state.distributions.find((x) => x.id === id);
            if (!d) return;
            const url = 'http://' + d.domainName + ':' + proxyPort + '/';
            await copy(url);
            btn.textContent = 'Copied';
            setTimeout(() => (btn.textContent = 'Copy proxy URL'), 900);
          });
        });
        el('#distributionList').querySelectorAll('[data-invalidate]').forEach((btn) => {
          btn.addEventListener('click', () => {
            el('input[name="distribution"]').value = btn.dataset.invalidate;
            el('input[name="paths"]').value = '/*';
            el('#invalidationForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        });
        el('#distributionList').querySelectorAll('[data-delete]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.delete;
            if (!confirm('Delete distribution ' + id + '?')) return;
            const r = await fetch('/distributions/' + encodeURIComponent(id), { method: 'DELETE' });
            if (!r.ok) {
              const data = await r.json().catch(() => ({}));
              throw new Error(data.error || 'delete failed');
            }
            await load();
          });
        });
      }

      if (!state.revalidations.length) {
        el('#revalidationList').innerHTML = '<div class="empty">No cache revalidations or invalidations yet.</div>';
      } else {
        el('#revalidationList').innerHTML = \`
          <div class="history-row history-head"><span>Time</span><span>Distribution</span><span>Path</span><span>Status</span><span>Result</span><span>TTL</span></div>
          \${state.revalidations.map((item) => \`
            <div class="history-row">
              <span>\${escapeHtml(fmtTime(item.timestamp))}</span>
              <span class="mono">\${escapeHtml(item.distribution)}</span>
              <span class="mono path-cell">\${escapeHtml(item.path)}</span>
              <span>\${escapeHtml(item.status)}</span>
              <span class="result-\${escapeHtml(item.result)}">\${escapeHtml(item.result)}</span>
              <span>\${item.ttl === undefined ? '—' : escapeHtml(item.ttl + 's')}</span>
            </div>
          \`).join('')}
        \`;
      }

      el('#healthLine').textContent = state.health?.ok ? 'Healthy' : 'Unreachable';
      el('#healthHint').textContent = state.health?.ok
        ? 'Admin API is responding on port ' + adminPort + '.'
        : 'Waiting for the admin API to answer.';
      el('#updatedAt').textContent = 'Updated ' + fmtTime(Date.now());
    }

    async function load() {
      const [healthRes, statsRes, distRes, revalidationRes] = await Promise.all([
        fetch('/health').catch(() => null),
        fetch('/stats').catch(() => null),
        fetch('/distributions').catch(() => null),
        fetch('/revalidations').catch(() => null),
      ]);

      state.health = healthRes ? await healthRes.json().catch(() => ({ ok: false })) : { ok: false };
      state.stats = statsRes ? await statsRes.json().catch(() => ({})) : {};
      state.distributions = distRes ? (await distRes.json().catch(() => ({ distributions: [] }))).distributions || [] : [];
      state.revalidations = revalidationRes ? (await revalidationRes.json().catch(() => ({ revalidations: [] }))).revalidations || [] : [];
      render();
    }

    el('#refreshBtn').addEventListener('click', load);
    el('#copyApiBtn').addEventListener('click', async () => {
      await copy('http://localhost:' + adminPort + '/');
      el('#copyApiBtn').textContent = 'Copied';
      setTimeout(() => (el('#copyApiBtn').textContent = 'Copy admin URL'), 900);
    });

    el('#createForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      data.enabled = true;
      data.defaultTtl = data['default-ttl'] ? Number(data['default-ttl']) : undefined;
      data.minTtl = data['min-ttl'] ? Number(data['min-ttl']) : undefined;
      data.maxTtl = data['max-ttl'] ? Number(data['max-ttl']) : undefined;
      data.compress = form.querySelector('[name="compress"]').checked;
      data.forwardQueryString = form.querySelector('[name="forward-query"]').checked;
      if (!data.comment) delete data.comment;
      if (!data.id) delete data.id;
      if (!data.originPath && !data['origin-path']) delete data.originPath;
      const body = {
        origin: { domainName: data.origin },
        comment: data.comment || '',
        defaultCacheBehavior: {
          compress: data.compress,
          forwardQueryString: data.forwardQueryString,
        },
      };
      if (data.id) body.id = data.id;
      if (data.domain) body.domainName = data.domain;
      if (data['origin-path']) body.origin.originPath = data['origin-path'];
      if (data.defaultTtl !== undefined) body.defaultCacheBehavior.defaultTtl = data.defaultTtl;
      if (data.minTtl !== undefined) body.defaultCacheBehavior.minTtl = data.minTtl;
      if (data.maxTtl !== undefined) body.defaultCacheBehavior.maxTtl = data.maxTtl;
      const r = await fetch('/distributions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'create failed');
      }
      form.reset();
      form.querySelector('[name="compress"]').checked = true;
      await load();
    });

    el('#invalidationForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const dist = form.querySelector('[name="distribution"]').value.trim();
      const rawPaths = form.querySelector('[name="paths"]').value.trim();
      const paths = rawPaths ? rawPaths.split(',').map((s) => s.trim()).filter(Boolean) : ['/*'];
      const r = await fetch('/distributions/' + encodeURIComponent(dist) + '/invalidations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'invalidation failed');
      }
      form.reset();
      await load();
    });

    load().catch((err) => {
      el('#healthLine').textContent = 'Dashboard error';
      el('#healthHint').textContent = err.message;
      console.error(err);
    });
  </script>
</body>
</html>`;
}

function persist(state) {
  state.suppressReload = true;
  saveConfig({ distributions: state.config.distributions });
  setTimeout(() => (state.suppressReload = false), 400);
}

// ----------------------------------------------------------------------------- serve
function serve() {
  const cfg = loadConfig();
  const state = {
    config: { distributions: cfg.distributions.map(normalizeDistribution) },
    cache: new Cache(CACHE_MAX),
    metrics: { requests: 0, hits: 0, misses: 0, refreshHits: 0 },
    revalidations: [],
    suppressReload: false,
  };

  // persist normalized form once so IDs/domains are stable on disk
  saveConfig({ distributions: state.config.distributions });

  if (existsSync(CONFIG_PATH)) {
    let t;
    watch(CONFIG_PATH, () => {
      if (state.suppressReload) return;
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          const c = loadConfig();
          state.config.distributions = c.distributions.map(normalizeDistribution);
          console.log('[localfront] config reloaded — %d distribution(s)', state.config.distributions.length);
        } catch (e) {
          console.error('[localfront] reload failed:', e.message);
        }
      }, 150);
    });
  }

  const proxy = http.createServer((req, res) =>
    handleProxy(req, res, state).catch((e) => {
      try { sendPlain(res, 500, `LocalFront error: ${e.message}\n`); } catch {}
    })
  );
  proxy.listen(PROXY_PORT, () =>
    console.log(`LocalFront proxy  ->  http://localhost:${PROXY_PORT}`)
  );

  const admin = http.createServer((req, res) =>
    handleAdmin(req, res, state).catch((e) => {
      try { sendJson(res, 500, { error: e.message }); } catch {}
    })
  );
  admin.listen(ADMIN_PORT, () =>
    console.log(`LocalFront admin  ->  http://localhost:${ADMIN_PORT}`)
  );

  console.log(`config: ${CONFIG_PATH}`);
  if (!state.config.distributions.length) {
    console.log('no distributions yet. create one:');
    console.log(`  node localfront.mjs create-distribution --origin http://localhost:9000 --origin-path /assets`);
  } else {
    for (const d of state.config.distributions) {
      console.log(`  ${d.id}  ${d.domainName}  ->  ${d.origin.domainName}${d.origin.originPath || ''}  ${d.enabled ? '' : '(disabled)'}`);
    }
  }
}

// ----------------------------------------------------------------------------- CLI
function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) { out[k.slice(3)] = false; continue; }
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function distFromFlags(f, existing) {
  const d = existing ? JSON.parse(JSON.stringify(existing)) : { origin: {}, defaultCacheBehavior: {} };
  d.origin = d.origin || {};
  d.defaultCacheBehavior = d.defaultCacheBehavior || {};
  if (f.origin) d.origin.domainName = f.origin;
  if (f['origin-path'] !== undefined) d.origin.originPath = f['origin-path'] === true ? '' : f['origin-path'];
  if (f.comment) d.comment = f.comment;
  if (f.id) d.id = f.id;
  if (f.domain) d.domainName = f.domain;
  if (f['default-ttl'] !== undefined) d.defaultCacheBehavior.defaultTtl = +f['default-ttl'];
  if (f['min-ttl'] !== undefined) d.defaultCacheBehavior.minTtl = +f['min-ttl'];
  if (f['max-ttl'] !== undefined) d.defaultCacheBehavior.maxTtl = +f['max-ttl'];
  if (f.compress === false) d.defaultCacheBehavior.compress = false;
  if (f['forward-query']) d.defaultCacheBehavior.forwardQueryString = true;
  return d;
}

async function adminReachable() {
  try {
    const r = await fetch(`http://127.0.0.1:${ADMIN_PORT}/health`, { signal: AbortSignal.timeout(400) });
    return r.ok;
  } catch {
    return false;
  }
}

async function api(method, pathname, body) {
  const r = await fetch(`http://127.0.0.1:${ADMIN_PORT}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!r.ok) throw new Error(typeof json === 'string' ? json : json.error || `HTTP ${r.status}`);
  return json;
}

function printDist(d) {
  console.log(`  ID          ${d.id}`);
  console.log(`  Domain      http://${d.domainName}:${PROXY_PORT}/`);
  console.log(`  Origin      ${d.origin.domainName}${d.origin.originPath || ''}`);
  console.log(`  TTL         min=${d.defaultCacheBehavior.minTtl} default=${d.defaultCacheBehavior.defaultTtl} max=${d.defaultCacheBehavior.maxTtl}`);
  console.log(`  Compress    ${d.defaultCacheBehavior.compress}`);
  console.log(`  Enabled     ${d.enabled}`);
  console.log(`  Example     curl -H "X-Distribution-Id: ${d.id}" http://localhost:${PROXY_PORT}/<object-key>`);
}

const HELP = `LocalFront — local CloudFront-like CDN for MinIO / any HTTP origin

Usage:
  node localfront.mjs serve
  node localfront.mjs create-distribution --origin <url> [--origin-path /bucket] [options]
  node localfront.mjs list-distributions
  node localfront.mjs get-distribution <id>
  node localfront.mjs update-distribution <id> [options]
  node localfront.mjs delete-distribution <id>
  node localfront.mjs create-invalidation <id> --paths "/*" ["/img/*" ...]
  node localfront.mjs stats

Options for create/update:
  --origin <url>          origin endpoint, e.g. http://localhost:9000 (MinIO)
  --origin-path <path>    prepended to every request, e.g. /assets (the bucket)
  --domain <hostname>     friendly viewer hostname, e.g. site.local
  --default-ttl <sec>     TTL when origin sends no cache headers (default 86400)
  --min-ttl <sec>         floor TTL (default 0)
  --max-ttl <sec>         ceiling TTL (default 31536000)
  --no-compress           disable gzip/br compression
  --forward-query         include query string in the cache key
  --comment "<text>"      free-text comment
  --id <id>               force a specific distribution id

Env:
  LOCALFRONT_PORT (8080)  LOCALFRONT_ADMIN_PORT (5744)  LOCALFRONT_CONFIG (./distributions.json)

Friendly hostnames (Windows PowerShell as Administrator):
  npm run hosts:setup
  ipconfig /flushdns

MinIO public-read setup:
  mc alias set local http://localhost:9000 minioadmin minioadmin
  mc anonymous set download local/<bucket>/<prefix>
  See README.md for the Docker Compose alternative.

Routing a request to a distribution (any of):
  Host subdomain   http://<id>.localhost:8080/key
  Header           curl -H "X-Distribution-Id: <id>" http://localhost:8080/key
  Path prefix      http://localhost:8080/_d/<id>/key
  Single default   if exactly one distribution exists, it is used automatically
`;

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  const up = await adminReachable();

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    case 'serve':
      return serve();

    case 'create-distribution': {
      const input = distFromFlags(f);
      let created;
      if (up) created = await api('POST', '/distributions', input);
      else {
        const cfg = loadConfig();
        created = normalizeDistribution(input);
        cfg.distributions = cfg.distributions.map(normalizeDistribution);
        cfg.distributions.push(created);
        saveConfig(cfg);
      }
      console.log('Created distribution:');
      printDist(created);
      if (!up) console.log('\n(server not running — start it with: node localfront.mjs serve)');
      return;
    }

    case 'list-distributions': {
      const list = up ? (await api('GET', '/distributions')).distributions : loadConfig().distributions.map(normalizeDistribution);
      if (!list.length) return console.log('(no distributions)');
      for (const d of list) {
        console.log(`${d.id}  ${d.domainName}  ->  ${d.origin.domainName}${d.origin.originPath || ''}  ${d.enabled ? '' : '[disabled]'}`);
      }
      return;
    }

    case 'get-distribution': {
      const id = f._[0];
      if (!id) return console.error('usage: get-distribution <id>');
      const d = up
        ? await api('GET', `/distributions/${id}`)
        : loadConfig().distributions.map(normalizeDistribution).find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (!d) return console.error(`distribution ${id} not found`);
      printDist(d);
      return;
    }

    case 'update-distribution': {
      const id = f._[0];
      if (!id) return console.error('usage: update-distribution <id> [options]');
      let updated;
      if (up) updated = await api('PUT', `/distributions/${id}`, distFromFlags(f));
      else {
        const cfg = loadConfig();
        cfg.distributions = cfg.distributions.map(normalizeDistribution);
        const idx = cfg.distributions.findIndex((x) => x.id.toLowerCase() === id.toLowerCase());
        if (idx === -1) return console.error(`distribution ${id} not found`);
        updated = normalizeDistribution(distFromFlags(f, cfg.distributions[idx]));
        cfg.distributions[idx] = updated;
        saveConfig(cfg);
      }
      console.log('Updated:');
      printDist(updated);
      return;
    }

    case 'delete-distribution': {
      const id = f._[0];
      if (!id) return console.error('usage: delete-distribution <id>');
      if (up) await api('DELETE', `/distributions/${id}`);
      else {
        const cfg = loadConfig();
        cfg.distributions = cfg.distributions.map(normalizeDistribution).filter((x) => x.id.toLowerCase() !== id.toLowerCase());
        saveConfig(cfg);
      }
      console.log(`Deleted ${id}`);
      return;
    }

    case 'create-invalidation': {
      const id = f._[0];
      if (!id) return console.error('usage: create-invalidation <id> --paths "/*"');
      if (!up) return console.error('server must be running to invalidate cache (node localfront.mjs serve)');
      let paths = [];
      if (Array.isArray(f.paths)) paths = f.paths;
      else if (typeof f.paths === 'string') paths = [f.paths];
      if (f._.length > 1) paths = paths.concat(f._.slice(1));
      if (!paths.length) paths = ['/*'];
      const r = await api('POST', `/distributions/${id}/invalidations`, { paths });
      console.log(`Invalidation ${r.id}: removed ${r.invalidated} cached object(s) for ${paths.join(', ')}`);
      return;
    }

    case 'stats': {
      if (!up) return console.error('server not running');
      console.log(JSON.stringify(await api('GET', '/stats'), null, 2));
      return;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

cli(process.argv.slice(2)).catch((e) => {
  console.error('error:', e.message);
  process.exitCode = 1;
});
