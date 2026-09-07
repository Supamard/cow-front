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

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

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
      originPath: (input.origin.originPath || '').replace(/\/+$/, ''),
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
  const originUrl = dist.origin.domainName + dist.origin.originPath + urlObj.pathname + urlObj.search;
  const fwd = buildForwardHeaders(req, dist, cached);
  let originRes;
  try {
    originRes = await fetch(originUrl, { method, headers: fwd, redirect: 'manual' });
  } catch (e) {
    return sendPlain(res, 502, `LocalFront: origin fetch failed (${originUrl}): ${e.message}\n`);
  }

  // stale-but-valid: origin says 304 -> refresh TTL, serve cached body
  if (cached && originRes.status === 304) {
    const rh = headersToObj(originRes.headers);
    const { ttl } = computeTtl(b, rh);
    cached.storedAt = now;
    cached.expiresAt = now + ttl * 1000;
    state.cache.set(key, cached);
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

  return deliver(res, req, dist, entry, 'Miss', state.metrics);
}

// ----------------------------------------------------------------------------- admin API
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
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

async function handleAdmin(req, res, state) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, service: 'localfront' });

  if (url.pathname === '/stats') {
    return sendJson(res, 200, {
      cacheEntries: state.cache.size(),
      cacheMax: state.cache.max,
      distributions: state.config.distributions.length,
      ...state.metrics,
    });
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
        return sendJson(res, 201, { id: 'I' + genId().slice(1), distribution: state.config.distributions[idx].id, paths, invalidated: count });
      }
    }
  }

  return sendJson(res, 404, { error: 'not found', hint: 'GET /distributions, POST /distributions, /stats, /health' });
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
  --default-ttl <sec>     TTL when origin sends no cache headers (default 86400)
  --min-ttl <sec>         floor TTL (default 0)
  --max-ttl <sec>         ceiling TTL (default 31536000)
  --no-compress           disable gzip/br compression
  --forward-query         include query string in the cache key
  --comment "<text>"      free-text comment
  --id <id>               force a specific distribution id

Env:
  LOCALFRONT_PORT (8080)  LOCALFRONT_ADMIN_PORT (5744)  LOCALFRONT_CONFIG (./distributions.json)

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
