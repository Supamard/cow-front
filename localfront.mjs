#!/usr/bin/env node
/*
 * CowFront — a local, CloudFront-like CDN emulator that fronts MinIO (or any HTTP origin).
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
import { mkdirSync, readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as querystring from 'node:querystring';
import { runAudit, formatAuditReport } from './scripts/audit.mjs';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.LOCALFRONT_CONFIG || path.resolve(process.cwd(), 'distributions.json');
const PROXY_PORT = parseInt(process.env.LOCALFRONT_PORT || '8080', 10);
const ADMIN_PORT = parseInt(process.env.LOCALFRONT_ADMIN_PORT || '5744', 10);
const CACHE_MAX = parseInt(process.env.LOCALFRONT_CACHE_MAX || '5000', 10);
const FUNCTION_TIMEOUT_MS = parseInt(process.env.LOCALFRONT_FUNCTION_TIMEOUT_MS || '100', 10);
const HOSTS_PATH = process.env.LOCALFRONT_HOSTS_PATH || (process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts');
const CADDYFILE_PATH = process.env.LOCALFRONT_CADDYFILE || path.join(APP_ROOT, 'Caddyfile');

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

function isBuiltInLocalHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value.endsWith('.localhost');
}

function mappedLoopbackHostnames() {
  if (!existsSync(HOSTS_PATH)) return new Set();
  const mapped = new Set();
  for (const line of readFileSync(HOSTS_PATH, 'utf8').split(/\r?\n/)) {
    const active = line.split('#')[0].trim();
    if (!active) continue;
    const [address, ...aliases] = active.split(/\s+/);
    if (address !== '127.0.0.1' && address !== '::1') continue;
    for (const alias of aliases) mapped.add(alias.toLowerCase());
  }
  return mapped;
}

function validHostname(hostname) {
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) && hostname.length <= 253;
}

function syncCaddyDistributionRoutes(distributions, reload = true) {
  if (!existsSync(CADDYFILE_PATH)) return { configured: false, reloaded: false };
  const markerStart = '# CowFront distribution routes - managed block';
  const markerEnd = '# End CowFront distribution routes';
  const current = readFileSync(CADDYFILE_PATH, 'utf8');
  const blockPattern = new RegExp(`${escapeRegex(markerStart)}[\\s\\S]*?${escapeRegex(markerEnd)}`);
  if (!blockPattern.test(current)) return { configured: false, reloaded: false };

  const hostnames = [...new Set(distributions
    .map((distribution) => String(distribution.domainName || '').trim().toLowerCase())
    .filter((hostname) => validHostname(hostname) && hostname !== 'cowfront.local' && !isBuiltInLocalHostname(hostname)))]
    .sort();
  const routes = hostnames.map((hostname) =>
    `http://${hostname} {\n\t@remote not remote_ip 127.0.0.1 ::1\n\trespond @remote "CowFront distributions are available only on the machine running them." 403\n\n\treverse_proxy 127.0.0.1:${PROXY_PORT}\n}`
  ).join('\n\n');
  const managed = `${markerStart}\n# Generated by CowFront. Edit distributions in the dashboard.\n${routes}${routes ? '\n' : ''}${markerEnd}`;
  const next = current.replace(blockPattern, managed);
  if (next !== current) writeFileSync(CADDYFILE_PATH, next, 'utf8');

  if (!reload || process.env.LOCALFRONT_SKIP_CADDY_RELOAD) return { configured: true, reloaded: false };
  const result = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'caddy.mjs'), 'reload'], {
    cwd: APP_ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return {
    configured: true,
    reloaded: result.status === 0,
    error: result.status === 0 ? undefined : (result.stderr || result.stdout || result.error?.message || 'Caddy reload failed').trim(),
  };
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

function saveFunctionSource(distributionId, eventType, name, code) {
  if (!['viewerRequest', 'viewerResponse'].includes(eventType)) {
    throw new Error('eventType must be viewerRequest or viewerResponse');
  }
  if (typeof code !== 'string' || !code.trim()) throw new Error('function code is required');
  if (Buffer.byteLength(code) > 1024 * 1024) throw new Error('function code must be 1 MB or smaller');
  if (!/\b(?:async\s+)?function\s+handler\s*\(/.test(code)) {
    throw new Error('function code must declare function handler(event)');
  }
  if (eventType === 'viewerResponse' && /\breturn\s+request\s*;/.test(code) && !/\bevent\.response\b/.test(code)) {
    throw new Error('this code reads event.request but not event.response; associate it as a viewer-request function');
  }
  try { new vm.Script(code, { filename: name || 'cloudfront-function.js' }); }
  catch (error) { throw new Error(`function syntax error: ${error.message}`); }

  const safeName = path.basename(String(name || `${eventType}.js`))
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || `${eventType}.js`;
  const filename = `${distributionId}-${safeName.endsWith('.js') ? safeName : `${safeName}.js`}`;
  const directory = path.join(path.dirname(CONFIG_PATH), '.localfront-functions');
  mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, filename);
  writeFileSync(destination, code, 'utf8');
  return './' + path.relative(path.dirname(CONFIG_PATH), destination).replaceAll('\\', '/');
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
  const functions = b.functionAssociations || {};
  const functionCode = input.functionCode || {};
  const res = {
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
      functionAssociations: {
        viewerRequest: functions.viewerRequest ? String(functions.viewerRequest) : '',
        viewerResponse: functions.viewerResponse ? String(functions.viewerResponse) : '',
      },
    },
    createdAt: input.createdAt || new Date().toISOString(),
  };
  const codeEntries = {};
  if (functionCode.viewerRequest && typeof functionCode.viewerRequest === 'string') {
    codeEntries.viewerRequest = functionCode.viewerRequest;
  }
  if (functionCode.viewerResponse && typeof functionCode.viewerResponse === 'string') {
    codeEntries.viewerResponse = functionCode.viewerResponse;
  }
  if (Object.keys(codeEntries).length > 0) res.functionCode = codeEntries;
  return res;
}

// ----------------------------------------------------------------------------- CloudFront Functions
function functionFile(file) {
  return path.isAbsolute(file) ? file : path.resolve(path.dirname(CONFIG_PATH), file);
}

function populateFunctionCodeFromDisk(distribution) {
  const associations = distribution.defaultCacheBehavior?.functionAssociations || {};
  distribution.functionCode = distribution.functionCode || {};
  for (const eventType of ['viewerRequest', 'viewerResponse']) {
    const filePath = associations[eventType];
    if (filePath && !distribution.functionCode[eventType]) {
      const resolved = functionFile(filePath);
      if (existsSync(resolved)) {
        try {
          distribution.functionCode[eventType] = readFileSync(resolved, 'utf8');
        } catch {}
      }
    }
  }
  if (!distribution.functionCode.viewerRequest && !distribution.functionCode.viewerResponse) {
    delete distribution.functionCode;
  }
}

function restoreFunctionFiles(distributions) {
  let restored = 0;
  for (const d of distributions) {
    if (!d.functionCode) continue;
    const associations = d.defaultCacheBehavior?.functionAssociations || {};
    for (const eventType of ['viewerRequest', 'viewerResponse']) {
      const code = d.functionCode[eventType];
      if (!code || typeof code !== 'string' || !code.trim()) continue;
      let relPath = associations[eventType];
      if (!relPath) {
        relPath = `./.localfront-functions/${d.id}-${eventType}.js`;
        associations[eventType] = relPath;
      }
      const resolved = functionFile(relPath);
      if (!existsSync(resolved)) {
        try {
          mkdirSync(path.dirname(resolved), { recursive: true });
          writeFileSync(resolved, code, 'utf8');
          restored++;
        } catch (e) {
          console.error(`[localfront] failed to restore function file ${resolved}: ${e.message}`);
        }
      }
    }
  }
  return restored;
}

function eventHeadersFromRaw(rawHeaders) {
  const grouped = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase();
    if (name === 'cookie') continue;
    const values = grouped.get(name) || [];
    values.push(String(rawHeaders[i + 1]));
    grouped.set(name, values);
  }
  const result = {};
  for (const [name, values] of grouped) {
    result[name] = { value: values[0] };
    if (values.length > 1) result[name].multiValue = values.map((value) => ({ value }));
  }
  return result;
}

function eventCookies(cookieHeaders = []) {
  const grouped = new Map();
  for (const line of cookieHeaders) {
    for (const part of String(line).split(';')) {
      const separator = part.indexOf('=');
      const name = (separator === -1 ? part : part.slice(0, separator)).trim();
      if (!name) continue;
      const value = separator === -1 ? '' : part.slice(separator + 1).trim();
      const values = grouped.get(name) || [];
      values.push(value);
      grouped.set(name, values);
    }
  }
  const result = {};
  for (const [name, values] of grouped) {
    result[name] = { value: values[0] };
    if (values.length > 1) result[name].multiValue = values.map((value) => ({ value }));
  }
  return result;
}

function eventQuery(searchParams) {
  const grouped = new Map();
  for (const [name, value] of searchParams) {
    const values = grouped.get(name) || [];
    values.push(value);
    grouped.set(name, values);
  }
  const result = {};
  for (const [name, values] of grouped) {
    result[name] = { value: values[0] };
    if (values.length > 1) result[name].multiValue = values.map((value) => ({ value }));
  }
  return result;
}

function valuesFromEventField(field = {}) {
  if (Array.isArray(field.multiValue)) return field.multiValue.map((item) => String(item.value ?? ''));
  return [String(field.value ?? '')];
}

function queryFromEvent(querystring) {
  if (typeof querystring === 'string') return querystring ? `?${querystring.replace(/^\?/, '')}` : '';
  const params = new URLSearchParams();
  for (const [name, field] of Object.entries(querystring || {})) {
    for (const value of valuesFromEventField(field)) params.append(name, value);
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

function plainHeadersFromEvent(headers = {}) {
  const result = {};
  for (const [name, field] of Object.entries(headers)) {
    if (name !== name.toLowerCase()) throw new Error(`header names must be lowercase: ${name}`);
    const values = valuesFromEventField(field);
    result[name] = values.length === 1 ? values[0] : values.join(', ');
  }
  return result;
}

function cookieHeaderFromEvent(cookies = {}) {
  const pairs = [];
  for (const [name, field] of Object.entries(cookies)) {
    for (const value of valuesFromEventField(field)) pairs.push(`${name}=${value}`);
  }
  return pairs.join('; ');
}

function setCookieHeadersFromEvent(cookies = {}) {
  const values = [];
  for (const [name, field] of Object.entries(cookies)) {
    const items = Array.isArray(field.multiValue) ? field.multiValue : [field];
    for (const item of items) {
      values.push(`${name}=${String(item.value ?? '')}${item.attributes ? `; ${item.attributes}` : ''}`);
    }
  }
  return values;
}

function functionRequest(req, urlObj) {
  const cookieHeaders = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === 'cookie') cookieHeaders.push(req.rawHeaders[i + 1]);
  }
  return {
    method: req.method,
    uri: urlObj.pathname,
    querystring: eventQuery(urlObj.searchParams),
    headers: eventHeadersFromRaw(req.rawHeaders),
    cookies: eventCookies(cookieHeaders),
  };
}

function eventHeadersFromPlain(headers = {}) {
  const result = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    result[name.toLowerCase()] = { value: String(values[0] ?? '') };
    if (values.length > 1) result[name.toLowerCase()].multiValue = values.map((value) => ({ value: String(value) }));
  }
  return result;
}

function functionResponse(entry) {
  const headers = { ...entry.headers };
  const setCookies = headers['set-cookie'];
  delete headers['set-cookie'];
  const cookies = {};
  for (const line of Array.isArray(setCookies) ? setCookies : (setCookies ? [setCookies] : [])) {
    const [pair, ...attributes] = String(line).split(';');
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    const item = { value: pair.slice(separator + 1).trim() };
    if (attributes.length) item.attributes = attributes.join(';').trim();
    if (!cookies[name]) cookies[name] = item;
    else {
      if (!cookies[name].multiValue) cookies[name].multiValue = [{ ...cookies[name] }];
      cookies[name].multiValue.push(item);
    }
  }
  return {
    statusCode: entry.status,
    statusDescription: http.STATUS_CODES[entry.status] || '',
    headers: eventHeadersFromPlain(headers),
    cookies,
  };
}

function bodyFromFunction(body, fallback) {
  if (body === undefined) return fallback;
  if (typeof body === 'string') return Buffer.from(body);
  if (!body || typeof body !== 'object') throw new Error('response.body must be a string or { encoding, data }');
  if (body.encoding === 'base64') return Buffer.from(String(body.data || ''), 'base64');
  if (body.encoding === undefined || body.encoding === 'text') return Buffer.from(String(body.data || ''));
  throw new Error(`unsupported response body encoding: ${body.encoding}`);
}

async function runCloudFrontFunction(file, event, fallbackCode) {
  const resolved = functionFile(file);
  let source;
  try {
    source = readFileSync(resolved, 'utf8');
  } catch (error) {
    if (fallbackCode && typeof fallbackCode === 'string') {
      try {
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, fallbackCode, 'utf8');
        source = fallbackCode;
      } catch {
        source = fallbackCode;
      }
    } else {
      throw new Error(`${file}: ${error.message}`);
    }
  }

  const sandbox = {
    __event: structuredClone(event),
    __result: undefined,
    Buffer,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    require: (name) => {
      if (name === 'crypto') return Object.freeze({ createHash, createHmac });
      if (name === 'querystring') return querystring;
      if (name === 'buffer') return Object.freeze({ Buffer });
      throw new Error(`module is not available in the local CloudFront runtime: ${name}`);
    },
    console: Object.freeze({
      log: (...args) => console.log(`[function:${path.basename(file)}]`, ...args),
      error: (...args) => console.error(`[function:${path.basename(file)}]`, ...args),
    }),
  };
  const context = vm.createContext(sandbox, {
    name: `CloudFront Function ${file}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`${source}\n;globalThis.__result = handler(globalThis.__event);`, { filename: resolved });
  script.runInContext(context, { timeout: FUNCTION_TIMEOUT_MS });
  if (!sandbox.__result || typeof sandbox.__result.then !== 'function') return sandbox.__result;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timed out after ${FUNCTION_TIMEOUT_MS}ms`)), FUNCTION_TIMEOUT_MS);
  });
  try { return await Promise.race([Promise.resolve(sandbox.__result), timeout]); }
  finally { clearTimeout(timeoutId); }
}

function functionEvent(dist, eventType, request, response, requestId) {
  return {
    version: '1.0',
    context: {
      distributionDomainName: dist.domainName,
      distributionId: dist.id,
      eventType,
      requestId,
    },
    viewer: { ip: request.viewerIp },
    request: request.event,
    ...(response ? { response } : {}),
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
  if (req.modifiedByFunction) {
    Object.assign(h, req.headers);
    for (const name of ['connection', 'content-length', 'expect', 'host', 'keep-alive',
      'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
      'upgrade', 'via', 'x-distribution-id']) delete h[name];
  }
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

function entryFromFunctionResponse(response, fallbackBody = Buffer.alloc(0)) {
  if (!response || typeof response !== 'object' || !Number.isInteger(response.statusCode)) {
    throw new Error('function must return a CloudFront request or response object');
  }
  const headers = plainHeadersFromEvent(response.headers || {});
  const setCookies = setCookieHeadersFromEvent(response.cookies || {});
  if (setCookies.length) headers['set-cookie'] = setCookies;
  return {
    status: response.statusCode,
    headers,
    body: bodyFromFunction(response.body, fallbackBody),
    storedAt: Date.now(),
    expiresAt: 0,
  };
}

async function deliver(res, req, dist, entry, cacheStatus, metrics, functionRequestContext, requestId, runViewerResponse = true) {
  const headers = { ...entry.headers };
  for (const h of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding']) {
    delete headers[h];
  }

  let body = entry.body || Buffer.alloc(0);
  let status = entry.status;
  const b = dist.defaultCacheBehavior;

  const now = Date.now();
  const age = Math.max(0, Math.floor((now - entry.storedAt) / 1000));
  headers['x-cache'] = `${cacheStatus} from CowFront`;
  if (cacheStatus !== 'Miss') headers['age'] = String(age);
  headers['via'] = `1.1 ${dist.id.toLowerCase()}.localfront (CowFront)`;
  headers['x-amz-cf-pop'] = 'LOCAL1-C1';
  headers['x-amz-cf-id'] = requestId;
  headers['x-localfront-dist'] = dist.id;

  const viewerResponseFile = b.functionAssociations?.viewerResponse;
  if (runViewerResponse && viewerResponseFile) {
    const responseEvent = functionResponse({ status, headers, body });
    const result = await runCloudFrontFunction(
      viewerResponseFile,
      functionEvent(dist, 'viewer-response', functionRequestContext, responseEvent, requestId),
      dist.functionCode?.viewerResponse
    );
    if (result && typeof result === 'object' && typeof result.uri === 'string') {
      throw new Error('viewer-response function returned a request object; associate it as viewer-request instead');
    }
    const transformed = entryFromFunctionResponse(result, body);
    status = transformed.status;
    body = transformed.body;
    for (const name of Object.keys(headers)) delete headers[name];
    Object.assign(headers, transformed.headers);
  }

  const ae = req.headers['accept-encoding'] || '';
  const isHead = req.method === 'HEAD';
  const noBody = isHead || status === 204 || status === 304;

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

  // metrics
  metrics.requests++;
  if (cacheStatus === 'Hit') metrics.hits++;
  else if (cacheStatus === 'RefreshHit') metrics.refreshHits++;
  else metrics.misses++;

  res.writeHead(status, headers);
  if (noBody) res.end();
  else res.end(body);
}

async function handleProxy(req, res, state) {
  const dist = resolveDistribution(req, state.config.distributions);
  if (!dist) {
    return sendPlain(res, 404,
      'CowFront: no matching distribution.\n' +
      'Route via <id>.localhost, header "X-Distribution-Id: <id>", or path /_d/<id>/...\n');
  }
  if (!dist.enabled) return sendPlain(res, 403, `CowFront: distribution ${dist.id} is disabled.\n`);

  // strip /_d/<id> path prefix if used
  let rawUrl = req.url;
  const prefix = `/_d/${dist.id}/`;
  if (rawUrl.toLowerCase().startsWith(prefix.toLowerCase())) rawUrl = '/' + rawUrl.slice(prefix.length);

  let urlObj = new URL(rawUrl, 'http://localhost');
  const b = dist.defaultCacheBehavior;
  const requestId = randomBytes(24).toString('base64url');
  const originalFunctionRequest = functionRequest(req, urlObj);
  const functionRequestContext = {
    event: originalFunctionRequest,
    viewerIp: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
  };
  let edgeReq = { method: req.method, headers: { ...req.headers } };

  const viewerRequestFile = b.functionAssociations?.viewerRequest;
  if (viewerRequestFile) {
    let result;
    try {
      result = await runCloudFrontFunction(
        viewerRequestFile,
        functionEvent(dist, 'viewer-request', functionRequestContext, null, requestId),
        dist.functionCode?.viewerRequest
      );
    } catch (error) {
      return sendPlain(res, 502, `CowFront Function error (${viewerRequestFile}): ${error.message}\n`);
    }
    if (result && Number.isInteger(result.statusCode)) {
      let generated;
      try { generated = entryFromFunctionResponse(result); }
      catch (error) { return sendPlain(res, 502, `CowFront Function error (${viewerRequestFile}): ${error.message}\n`); }
      return deliver(res, edgeReq, dist, generated, 'FunctionGenerated', state.metrics, functionRequestContext, requestId, false);
    }
    if (!result || typeof result !== 'object' || typeof result.uri !== 'string' || !result.uri.startsWith('/')) {
      return sendPlain(res, 502, `CowFront Function error (${viewerRequestFile}): function must return a request with a URI beginning with /, or a response\n`);
    }
    try {
      const headers = plainHeadersFromEvent(result.headers || {});
      const cookie = cookieHeaderFromEvent(result.cookies || {});
      if (cookie) headers.cookie = cookie;
      urlObj = new URL(result.uri + queryFromEvent(result.querystring), 'http://localhost');
      edgeReq = { method: result.method || req.method, headers, modifiedByFunction: true };
      functionRequestContext.event = result;
    } catch (error) {
      return sendPlain(res, 502, `CowFront Function error (${viewerRequestFile}): ${error.message}\n`);
    }
  }

  const method = edgeReq.method;
  const cacheableMethod = b.cachedMethods.includes(method);
  const hasRange = !!edgeReq.headers['range'];
  const key = cacheKey(dist, edgeReq, urlObj);
  const now = Date.now();

  // fresh cache hit
  let cached = cacheableMethod && !hasRange ? state.cache.get(key) : null;
  if (cached && now < cached.expiresAt) {
    try { return await deliver(res, edgeReq, dist, cached, 'Hit', state.metrics, functionRequestContext, requestId); }
    catch (error) { return sendPlain(res, 502, `CowFront Function error (${b.functionAssociations.viewerResponse}): ${error.message}\n`); }
  }

  // fetch from origin (conditional revalidation if we hold a stale entry)
  const isRevalidation = !!cached;
  const originUrl = dist.origin.domainName + dist.origin.originPath + urlObj.pathname + urlObj.search;
  const fwd = buildForwardHeaders(edgeReq, dist, cached);
  let originRes;
  try {
    originRes = await fetch(originUrl, { method, headers: fwd, redirect: 'manual' });
  } catch (e) {
    if (isRevalidation) {
      recordRevalidation(state, { distribution: dist.id, method, path: urlObj.pathname, origin: originUrl, status: 'error', result: 'failed' });
    }
    return sendPlain(res, 502, `CowFront: origin fetch failed (${originUrl}): ${e.message}\n`);
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
    try { return await deliver(res, edgeReq, dist, cached, 'RefreshHit', state.metrics, functionRequestContext, requestId); }
    catch (error) { return sendPlain(res, 502, `CowFront Function error (${b.functionAssociations.viewerResponse}): ${error.message}\n`); }
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

  try { return await deliver(res, edgeReq, dist, entry, 'Miss', state.metrics, functionRequestContext, requestId); }
  catch (error) { return sendPlain(res, 502, `CowFront Function error (${b.functionAssociations.viewerResponse}): ${error.message}\n`); }
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

  if (url.pathname === '/audit' && method === 'GET') {
    const result = await runAudit({
      appRoot: APP_ROOT,
      configPath: CONFIG_PATH,
      hostsPath: HOSTS_PATH,
      caddyfilePath: CADDYFILE_PATH,
    });
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/host-mappings' && method === 'GET') {
    const mapped = mappedLoopbackHostnames();
    const mappings = {};
    for (const distribution of state.config.distributions) {
      const hostname = distribution.domainName.toLowerCase();
      const builtIn = isBuiltInLocalHostname(hostname);
      mappings[hostname] = { hostname, mapped: builtIn || mapped.has(hostname), builtIn };
    }
    return sendJson(res, 200, { mappings });
  }

  if (url.pathname === '/host-mappings' && method === 'POST') {
    const body = await readBody(req);
    if (body.all) {
      const mapped = mappedLoopbackHostnames();
      const toMap = [];
      for (const d of state.config.distributions) {
        const h = String(d.domainName || '').trim().toLowerCase();
        if (validHostname(h) && !isBuiltInLocalHostname(h) && !mapped.has(h)) {
          toMap.push(h);
        }
      }
      if (!toMap.length) {
        return sendJson(res, 200, { mapped: [], message: 'all distribution hostnames are already mapped' });
      }
      const scriptPath = path.join(APP_ROOT, 'scripts', 'setup-hosts.mjs');
      const args = [scriptPath, ...toMap.flatMap((h) => ['--map', `${h}:${PROXY_PORT}`])];
      const result = spawnSync(process.execPath, args, {
        cwd: APP_ROOT,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || result.error?.message || 'bulk host setup failed').trim();
        return sendJson(res, 500, { error: detail });
      }
      const newlyMapped = mappedLoopbackHostnames();
      const successful = toMap.filter((h) => newlyMapped.has(h));
      return sendJson(res, 201, { mapped: successful, total: successful.length });
    }

    const hostname = String(body.hostname || '').trim().toLowerCase();
    if (!validHostname(hostname)) return sendJson(res, 400, { error: 'a valid hostname is required' });
    const distribution = state.config.distributions.find((item) => item.domainName.toLowerCase() === hostname);
    if (!distribution) return sendJson(res, 404, { error: `no distribution uses hostname ${hostname}` });
    if (isBuiltInLocalHostname(hostname) || mappedLoopbackHostnames().has(hostname)) {
      return sendJson(res, 200, { hostname, mapped: true, alreadyMapped: true });
    }

    const scriptPath = path.join(APP_ROOT, 'scripts', 'setup-hosts.mjs');
    const result = spawnSync(process.execPath, [scriptPath, '--map', `${hostname}:${PROXY_PORT}`], {
      cwd: APP_ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || result.error?.message || 'host setup failed').trim();
      return sendJson(res, 500, { error: detail });
    }
    if (!mappedLoopbackHostnames().has(hostname)) {
      return sendJson(res, 500, { error: `hostname ${hostname} was not added to ${HOSTS_PATH}` });
    }
    return sendJson(res, 201, { hostname, mapped: true });
  }

  if (parts[0] === 'distributions') {
    const id = parts[1];

    if (id === 'export' && method === 'GET') {
      for (const d of state.config.distributions) populateFunctionCodeFromDisk(d);
      return sendJson(res, 200, { distributions: state.config.distributions });
    }

    if (id === 'import' && method === 'POST') {
      const body = await readBody(req);
      const incoming = (Array.isArray(body.distributions) ? body.distributions : (Array.isArray(body) ? body : []))
        .map(normalizeDistribution);
      const replace = !!body.replace;
      const existing = replace ? [] : state.config.distributions;
      let count = 0;
      for (const item of incoming) {
        const idx = existing.findIndex((d) => d.id.toLowerCase() === item.id.toLowerCase());
        if (idx !== -1) existing[idx] = item;
        else existing.push(item);
        count++;
      }
      state.config.distributions = existing;
      const restored = restoreFunctionFiles(state.config.distributions);
      for (const d of state.config.distributions) populateFunctionCodeFromDisk(d);
      persist(state);
      return sendJson(res, 200, { ok: true, imported: count, restoredFunctions: restored, total: state.config.distributions.length });
    }

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

      if (method === 'POST' && parts[2] === 'functions') {
        const body = await readBody(req);
        let functionPath;
        try {
          functionPath = saveFunctionSource(
            state.config.distributions[idx].id,
            body.eventType,
            body.name,
            body.code
          );
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        const associations = state.config.distributions[idx].defaultCacheBehavior.functionAssociations;
        const otherEventType = body.eventType === 'viewerRequest' ? 'viewerResponse' : 'viewerRequest';
        associations[body.eventType] = functionPath;
        // Treat re-saving the same managed file under another event as a move, not a second association.
        if (associations[otherEventType] === functionPath) associations[otherEventType] = '';
        state.config.distributions[idx].functionCode = state.config.distributions[idx].functionCode || {};
        state.config.distributions[idx].functionCode[body.eventType] = body.code;
        persist(state);
        return sendJson(res, 201, {
          distribution: state.config.distributions[idx].id,
          eventType: body.eventType,
          functionPath,
        });
      }

      if (method === 'POST' && parts[2] === 'function-test') {
        const body = await readBody(req);
        const testPath = String(body.path || '/');
        if (!testPath.startsWith('/') || /[\r\n]/.test(testPath)) {
          return sendJson(res, 400, { error: 'test path must begin with /' });
        }
        let response;
        try {
          response = await fetch(`http://127.0.0.1:${PROXY_PORT}${testPath}`, {
            headers: { 'x-distribution-id': state.config.distributions[idx].id },
            redirect: 'manual',
          });
        } catch (error) {
          return sendJson(res, 502, { error: `test request failed: ${error.message}` });
        }
        const responseBody = Buffer.from(await response.arrayBuffer());
        return sendJson(res, 200, {
          status: response.status,
          statusText: response.statusText,
          headers: headersToObj(response.headers),
          body: responseBody.subarray(0, 65536).toString('utf8'),
          truncated: responseBody.length > 65536,
        });
      }

      if (method === 'PUT') {
        const body = await readBody(req);
        const current = state.config.distributions[idx];
        const merged = normalizeDistribution({
          ...current,
          ...body,
          id: current.id,
          origin: { ...current.origin, ...(body.origin || {}) },
          defaultCacheBehavior: {
            ...current.defaultCacheBehavior,
            ...(body.defaultCacheBehavior || {}),
            functionAssociations: {
              ...(current.defaultCacheBehavior.functionAssociations || {}),
              ...(body.defaultCacheBehavior?.functionAssociations || {}),
            },
          },
        });
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
  const examplePath = path.join(APP_ROOT, 'examples', 'cloudfront-functions', 'remove-html-extension.js');
  const removeHtmlTemplate = existsSync(examplePath)
    ? readFileSync(examplePath, 'utf8')
    : 'function handler(event) {\n  return event.request;\n}\n';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CowFront-Farm</title>
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
    button, .ghost, input, textarea, select {
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
    input, textarea, select {
      width: 100%;
      color: var(--text);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 14px;
      padding: 11px 12px;
      outline: none;
    }
    select { color: var(--foreground, var(--text)); background: var(--card, var(--panel)); }
    textarea { min-height: 88px; resize: vertical; }
    textarea.code-editor {
      min-height: 300px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.55;
      tab-size: 2;
    }
    .function-panel { grid-column: span 12; }
    .function-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .test-output {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      padding: 14px;
      color: var(--text);
      background: rgba(0,0,0,0.22);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 14px;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    input:focus, textarea:focus, select:focus {
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
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div class="wrap">
    <header class="app-header">
      <div class="brand-lockup">
        <img src="/cowfront-logo.png" alt="CowFront" />
        <span class="brand-tag">Admin</span>
      </div>
      <div class="header-copy">
        <h1>Manage every local site from one place.</h1>
        <p class="sub">Switch sites once, then test functions, clear cache, and open the active endpoint without losing context.</p>
      </div>
      <div class="toolbar" aria-label="Dashboard actions">
        <button class="secondary" id="auditSetupBtn" type="button" title="Audit system setup and dependencies">Audit Setup</button>
        <button class="secondary" id="copyApiBtn">Copy admin URL</button>
        <button class="primary" id="refreshBtn">Refresh data</button>
      </div>
    </header>

    <section class="overview" aria-label="Service overview">
      <div class="service-state">
        <span class="health-dot" aria-hidden="true"></span>
        <div>
          <div class="status-value" id="healthLine">Checking...</div>
          <div class="hint" id="healthHint">Loading the admin API and current stats.</div>
        </div>
      </div>
      <div class="stats-grid" id="statsGrid"></div>
      <div class="overview-meta" id="updatedAt">Not loaded yet</div>
    </section>

    <section class="site-context panel" aria-labelledby="workingSiteTitle">
      <div class="context-copy">
        <h2 id="workingSiteTitle">Working site</h2>
        <p class="hint" id="activeSiteSummary">Choose a site to apply it across the tools below.</p>
      </div>
      <label class="site-switcher">Site
        <select id="siteSwitcher" aria-describedby="activeSiteSummary">
          <option value="">Create a distribution first</option>
        </select>
      </label>
      <div class="context-actions">
        <button class="secondary" type="button" id="copySiteIdBtn" disabled>Copy ID</button>
        <button class="secondary" type="button" id="editSiteBtn" disabled>Edit site</button>
        <a class="button-link primary" id="openSiteBtn" href="#" target="_blank" rel="noreferrer" aria-disabled="true">Open site</a>
      </div>
    </section>

    <main class="workspace-grid">
      <section class="panel list-panel" aria-labelledby="sitesTitle">
        <div class="panel-head">
          <div>
            <h2 id="sitesTitle">Sites</h2>
            <p class="hint">Select a site to keep every tool in sync.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="ghost" id="exportDistributionsBtn" type="button" title="Export distributions with embedded functions">Export</button>
            <button class="ghost" id="importDistributionsBtn" type="button" title="Import distributions.json">Import</button>
            <input type="file" id="importFileInput" accept=".json" style="display:none;" />
            <div class="count-badge" id="distCount">0 total</div>
          </div>
        </div>
        <div class="panel-body">
          <div id="unmappedHostBanner" style="display:none; padding:10px 14px; margin-bottom:12px; background:rgba(255,212,140,0.12); border:1px solid rgba(255,212,140,0.3); border-radius:12px; align-items:center; justify-content:space-between; gap:10px;">
            <span style="font-size:13px; color:var(--warn);">⚠️ <strong id="unmappedHostCount">0</strong> domain(s) not mapped in hosts</span>
            <button class="ghost" id="mapAllHostsBtn" type="button" style="font-size:12px; padding:4px 10px;">Map All</button>
          </div>
          <label class="search-field"><span>Find a site</span>
            <input id="siteSearch" type="search" placeholder="Domain, ID, or origin" autocomplete="off" />
          </label>
          <div class="table" id="distributionList"></div>
        </div>
      </section>

      <div class="operations">
        <div class="operation-quick-grid">
          <section class="panel invalidate-panel" id="invalidatePanel">
            <div class="panel-head">
              <div>
                <h2>Invalidate cache</h2>
                <p class="hint">Clear one path or the entire working site.</p>
              </div>
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
                <div class="form-footer">
                  <span class="hint">Separate multiple paths with commas.</span>
                  <button class="primary" type="submit">Invalidate cache</button>
                </div>
              </form>
            </div>
          </section>

          <button class="panel add-site-launcher" id="openCreateDialogBtn" type="button" aria-haspopup="dialog" aria-controls="createSiteDialog">
            <span class="add-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span><strong>Add a site</strong><small>Create a distribution</small></span>
          </button>
        </div>

        <section class="panel function-panel" id="functionsPanel">
          <div class="panel-head">
            <div>
              <h2>CloudFront function</h2>
              <p class="hint">Associate code and test it against the working site.</p>
            </div>
            <div class="hint" id="functionAssociationHint">Upload a .js file or paste code</div>
          </div>
          <div class="panel-body">
            <form id="functionForm">
              <div class="field-row">
                <label>Distribution
                  <select name="distribution" id="functionDistribution" required>
                    <option value="">Create a distribution first</option>
                  </select>
                </label>
                <label>Event type
                  <select name="event-type" id="functionEventType">
                    <option value="viewerRequest">Viewer request</option>
                    <option value="viewerResponse">Viewer response</option>
                  </select>
                </label>
              </div>
              <div class="field-row">
                <label>Upload JavaScript
                  <input name="function-file" id="functionFile" type="file" accept=".js,text/javascript,application/javascript" />
                </label>
                <label>Saved filename
                  <input name="function-name" id="functionName" value="cloudfront-function.js" placeholder="cloudfront-function.js" />
                </label>
              </div>
              <label>Function code
                <textarea class="code-editor" name="function-code" id="functionCode" spellcheck="false" placeholder="function handler(event) {&#10;  return event.request;&#10;}" required></textarea>
              </label>
              <div class="function-actions">
                <button class="primary" type="submit" id="saveFunctionBtn">Save &amp; associate</button>
                <button class="secondary" type="button" id="loadHtmlExampleBtn">Load remove .html example</button>
              </div>
              <div class="hint" id="functionSaveStatus">The function is syntax-checked and stored beside distributions.json.</div>
            </form>

            <form class="test-form" id="functionTestForm">
              <label>Test path
                <input name="test-path" id="functionTestPath" value="/about.html?lang=en" required />
              </label>
              <button class="secondary" type="submit" id="runFunctionBtn">Run through local CDN</button>
              <pre class="test-output" id="functionTestOutput" hidden></pre>
            </form>
          </div>
        </section>

        <dialog class="create-dialog" id="createSiteDialog" aria-labelledby="createSiteTitle">
          <div class="dialog-head">
            <div>
              <h2 id="createSiteTitle">Add a site</h2>
              <p class="hint">Create another local distribution.</p>
            </div>
            <button class="icon-button" id="closeCreateDialogBtn" type="button" aria-label="Close add site dialog">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div class="panel-body">
          <form id="createForm" method="dialog">
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
            <div class="form-footer">
              <span class="hint">The distribution ID is generated automatically unless you provide one.</span>
              <div class="dialog-actions">
                <button class="secondary" id="cancelCreateDialogBtn" type="button">Cancel</button>
                <button class="primary" type="submit">Create distribution</button>
              </div>
            </div>
          </form>
          </div>
        </dialog>

        <dialog class="create-dialog" id="editSiteDialog" aria-labelledby="editSiteTitle">
          <div class="dialog-head">
            <div>
              <h2 id="editSiteTitle">Edit distribution</h2>
              <p class="hint" id="editSiteSubtitle">Update distribution settings.</p>
            </div>
            <button class="icon-button" id="closeEditDialogBtn" type="button" aria-label="Close edit distribution dialog">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div class="panel-body">
          <form id="editForm" method="dialog">
            <input type="hidden" name="id" id="editDistId" />
            <div class="field-row">
              <label>Distribution ID
                <input id="editDistIdDisplay" disabled readonly tabindex="-1" style="background: var(--surface-muted); color: var(--muted-foreground); cursor: not-allowed;" />
              </label>
              <label>Friendly hostname
                <input name="domain" id="editDomain" placeholder="site.local" required />
              </label>
            </div>
            <div class="field-row">
              <label>Origin URL
                <input name="origin" id="editOrigin" placeholder="http://localhost:9000" required />
              </label>
              <label>Origin path
                <input name="origin-path" id="editOriginPath" placeholder="/assets" />
              </label>
            </div>
            <div class="field-row">
              <label>Default TTL
                <input name="default-ttl" id="editDefaultTtl" type="number" min="0" placeholder="86400" />
              </label>
              <label>Min TTL
                <input name="min-ttl" id="editMinTtl" type="number" min="0" placeholder="0" />
              </label>
            </div>
            <div class="field-row">
              <label>Max TTL
                <input name="max-ttl" id="editMaxTtl" type="number" min="0" placeholder="31536000" />
              </label>
              <label style="display:flex; flex-direction:column; justify-content:center;">
                <span style="font-size:12px; font-weight:700; margin-bottom:6px;">Status</span>
                <span class="checks" style="margin:0; padding:4px 0;">
                  <label><input name="enabled" id="editEnabled" type="checkbox" /> Enabled</label>
                </span>
              </label>
            </div>
            <label>Comment
              <textarea name="comment" id="editComment" placeholder="Optional note for this distribution"></textarea>
            </label>
            <div class="checks">
              <label><input name="compress" id="editCompress" type="checkbox" /> Compress objects</label>
              <label><input name="forward-query" id="editForwardQuery" type="checkbox" /> Forward query string</label>
            </div>
            <div class="form-footer">
              <span class="hint">The distribution ID cannot be changed.</span>
              <div class="dialog-actions">
                <button class="secondary" id="cancelEditDialogBtn" type="button">Cancel</button>
                <button class="primary" type="submit">Save changes</button>
              </div>
            </div>
          </form>
          </div>
        </dialog>

        <dialog class="create-dialog" id="auditDialog" aria-labelledby="auditDialogTitle" style="max-width: 680px; width: 92vw;">
          <div class="dialog-head">
            <div>
              <h2 id="auditDialogTitle">Setup state audit</h2>
              <p class="hint" id="auditDialogSubtitle">Verifying system prerequisites and services against README</p>
            </div>
            <button class="icon-button" id="closeAuditDialogBtn" type="button" aria-label="Close audit dialog">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div class="panel-body">
            <div id="auditContent" style="display:grid; gap:16px;">
              <div class="hint">Loading audit results...</div>
            </div>
          </div>
        </dialog>
      </div>
    </main>

    <section class="panel revalidation-panel">
      <div class="panel-head">
        <div>
          <h2>Revalidation history</h2>
          <p class="hint">Latest 100 revalidations and invalidations across every site.</p>
        </div>
      </div>
      <div class="panel-body">
        <div class="history-table" id="revalidationList"></div>
      </div>
    </section>
    <footer class="footer-note">Admin API ${ADMIN_PORT} <span aria-hidden="true">·</span> Proxy ${PROXY_PORT}</footer>
  </div>

  <script>
    const proxyPort = ${PROXY_PORT};
    const adminPort = ${ADMIN_PORT};
    const removeHtmlTemplate = ${JSON.stringify(removeHtmlTemplate)};
    const el = (sel) => document.querySelector(sel);

    const state = {
      distributions: [],
      revalidations: [],
      hostMappings: {},
      stats: {},
      health: null,
      activeDistributionId: '',
      searchQuery: '',
    };

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

    function updateFunctionHint() {
      const distribution = state.distributions.find((d) => d.id === el('#functionDistribution').value);
      const eventType = el('#functionEventType').value;
      const association = distribution?.defaultCacheBehavior?.functionAssociations?.[eventType];
      el('#functionAssociationHint').textContent = association
        ? 'Associated: ' + association
        : 'No ' + (eventType === 'viewerRequest' ? 'viewer-request' : 'viewer-response') + ' function associated';
    }

    function showFunctionTest(data) {
      const output = el('#functionTestOutput');
      const headers = Object.entries(data.headers || {})
        .map(([name, value]) => name + ': ' + value)
        .join('\\n');
      output.textContent = 'HTTP ' + data.status + ' ' + (data.statusText || '') + '\\n' +
        headers + '\\n\\n' + (data.body || '') + (data.truncated ? '\\n\\n[body truncated]' : '');
      output.hidden = false;
    }

    function setActiveSite(id) {
      const distribution = state.distributions.find((item) => item.id === id) || null;
      state.activeDistributionId = distribution?.id || '';
      el('#siteSwitcher').value = state.activeDistributionId;
      el('#functionDistribution').value = state.activeDistributionId;
      el('input[name="distribution"]').value = state.activeDistributionId;
      el('#copySiteIdBtn').disabled = !distribution;
      el('#editSiteBtn').disabled = !distribution;

      const openButton = el('#openSiteBtn');
      if (distribution) {
        const origin = distribution.origin.domainName + (distribution.origin.originPath || '');
        openButton.href = 'http://' + distribution.domainName + ':' + proxyPort + '/';
        openButton.setAttribute('aria-disabled', 'false');
        el('#activeSiteSummary').textContent = distribution.id + ' · ' + origin;
      } else {
        openButton.href = '#';
        openButton.setAttribute('aria-disabled', 'true');
        el('#activeSiteSummary').textContent = 'Create a distribution to use the site tools.';
      }

      el('#distributionList').querySelectorAll('[data-site-card]').forEach((card) => {
        card.classList.toggle('is-active', card.dataset.siteCard === state.activeDistributionId);
      });
      updateFunctionHint();
    }

    function renderDistributionList() {
      const query = state.searchQuery.trim().toLowerCase();
      const visible = query
        ? state.distributions.filter((d) => [d.id, d.domainName, d.origin.domainName, d.origin.originPath, d.comment]
            .filter(Boolean).join(' ').toLowerCase().includes(query))
        : state.distributions;

      el('#distCount').textContent = query
        ? visible.length + ' of ' + state.distributions.length
        : state.distributions.length + ' total';

      if (!state.distributions.length) {
        el('#distributionList').innerHTML = '<div class="empty">No sites yet. Open “Add a site” to create the first distribution.</div>';
        return;
      }
      if (!visible.length) {
        el('#distributionList').innerHTML = '<div class="empty">No sites match that search. Try a domain, distribution ID, or origin.</div>';
        return;
      }

      el('#distributionList').innerHTML = visible.map((d) => {
        const enabled = d.enabled !== false;
        const originUrl = d.origin.domainName + (d.origin.originPath || '');
        const ttl = [d.defaultCacheBehavior.minTtl, d.defaultCacheBehavior.defaultTtl, d.defaultCacheBehavior.maxTtl].join(' / ');
        const associations = d.defaultCacheBehavior.functionAssociations || {};
        const functionCount = Number(Boolean(associations.viewerRequest)) + Number(Boolean(associations.viewerResponse));
        const hostMapping = state.hostMappings[String(d.domainName).toLowerCase()];
        const mapAction = hostMapping && !hostMapping.mapped
          ? \`<button class="ghost" data-map-host="\${escapeHtml(d.domainName)}">Map hostname</button>\`
          : '';
        return \`
          <article class="dist \${d.id === state.activeDistributionId ? 'is-active' : ''}" data-site-card="\${escapeHtml(d.id)}">
            <div class="dist-top">
              <button class="site-select" type="button" data-select-site="\${escapeHtml(d.id)}" aria-label="Work on \${escapeHtml(d.domainName)}">
                <span class="dist-domain">\${escapeHtml(d.domainName)}</span>
                <span class="dist-id">\${escapeHtml(d.id)}</span>
              </button>
              <span class="chip \${enabled ? 'good' : 'bad'}">\${enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <div class="meta">
              <div class="meta-row"><strong>Origin</strong><span class="meta-value" title="\${escapeHtml(originUrl)}">\${escapeHtml(originUrl)}</span></div>
              <div class="meta-row"><strong>TTL</strong><span class="meta-value">\${escapeHtml(ttl)} seconds</span></div>
              <div class="meta-row"><strong>Functions</strong><span class="meta-value">\${functionCount ? functionCount + ' associated' : 'None associated'}</span></div>
              \${d.comment ? '<div class="meta-row"><strong>Note</strong><span class="meta-value" title="' + escapeHtml(d.comment) + '">' + escapeHtml(d.comment) + '</span></div>' : ''}
            </div>
            <div class="actions">
              <button class="ghost" data-proxy="\${escapeHtml(d.id)}">Copy URL</button>
              \${mapAction}
              <button class="ghost" data-edit="\${escapeHtml(d.id)}">Edit</button>
              <button class="ghost" data-function="\${escapeHtml(d.id)}">Functions</button>
              <button class="ghost" data-invalidate="\${escapeHtml(d.id)}">Invalidate</button>
              <button class="ghost" data-delete="\${escapeHtml(d.id)}">Delete</button>
            </div>
          </article>
        \`;
      }).join('');

      el('#distributionList').querySelectorAll('[data-select-site]').forEach((button) => {
        button.addEventListener('click', () => setActiveSite(button.dataset.selectSite));
      });
      el('#distributionList').querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => openEditDialog(button.dataset.edit));
      });
      el('#distributionList').querySelectorAll('[data-proxy]').forEach((button) => {
        button.addEventListener('click', async () => {
          const distribution = state.distributions.find((item) => item.id === button.dataset.proxy);
          if (!distribution) return;
          await copy('http://' + distribution.domainName + ':' + proxyPort + '/');
          button.textContent = 'Copied';
          setTimeout(() => (button.textContent = 'Copy URL'), 900);
        });
      });
      el('#distributionList').querySelectorAll('[data-invalidate]').forEach((button) => {
        button.addEventListener('click', () => {
          setActiveSite(button.dataset.invalidate);
          el('input[name="paths"]').value = '/*';
          el('#invalidatePanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      el('#distributionList').querySelectorAll('[data-function]').forEach((button) => {
        button.addEventListener('click', () => {
          setActiveSite(button.dataset.function);
          el('#functionsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      el('#distributionList').querySelectorAll('[data-map-host]').forEach((button) => {
        button.addEventListener('click', async () => {
          const hostname = button.dataset.mapHost;
          button.disabled = true;
          button.textContent = 'Mapping...';
          try {
            const response = await fetch('/host-mappings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ hostname }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'hostname mapping failed');
            await load();
          } catch (error) {
            button.disabled = false;
            button.textContent = 'Map hostname';
            alert(error.message);
          }
        });
      });
      el('#distributionList').querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.dataset.delete;
          if (!confirm('Delete distribution ' + id + '?')) return;
          const response = await fetch('/distributions/' + encodeURIComponent(id), { method: 'DELETE' });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'delete failed');
          }
          await load();
        });
      });
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

      const functionDistribution = el('#functionDistribution');
      const selectedDistribution = functionDistribution.value;
      functionDistribution.innerHTML = state.distributions.length
        ? state.distributions.map((d) => \`<option value="\${escapeHtml(d.id)}">\${escapeHtml(d.id + ' — ' + d.domainName)}</option>\`).join('')
        : '<option value="">Create a distribution first</option>';
      if (state.distributions.some((d) => d.id === selectedDistribution)) {
        functionDistribution.value = selectedDistribution;
      }
      const siteSwitcher = el('#siteSwitcher');
      siteSwitcher.innerHTML = state.distributions.length
        ? state.distributions.map((d) => \`<option value="\${escapeHtml(d.id)}">\${escapeHtml(d.domainName + ' — ' + d.id)}</option>\`).join('')
        : '<option value="">Create a distribution first</option>';
      if (!state.distributions.some((d) => d.id === state.activeDistributionId)) {
        state.activeDistributionId = state.distributions[0]?.id || '';
      }

      renderDistributionList();
      setActiveSite(state.activeDistributionId);

      const unmapped = state.distributions.filter((d) => {
        const mapping = state.hostMappings[String(d.domainName).toLowerCase()];
        return mapping && !mapping.mapped && !mapping.builtIn;
      });
      const banner = el('#unmappedHostBanner');
      if (banner) {
        if (unmapped.length > 0) {
          banner.style.display = 'flex';
          el('#unmappedHostCount').textContent = unmapped.length;
        } else {
          banner.style.display = 'none';
        }
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
      el('.health-dot').classList.toggle('is-down', !state.health?.ok);
      el('#healthHint').textContent = state.health?.ok
        ? 'Admin API is responding on port ' + adminPort + '.'
        : 'Waiting for the admin API to answer.';
      el('#updatedAt').textContent = 'Updated ' + fmtTime(Date.now());
    }

    async function load() {
      const [healthRes, statsRes, distRes, revalidationRes, hostMappingsRes] = await Promise.all([
        fetch('/health').catch(() => null),
        fetch('/stats').catch(() => null),
        fetch('/distributions').catch(() => null),
        fetch('/revalidations').catch(() => null),
        fetch('/host-mappings').catch(() => null),
      ]);

      state.health = healthRes ? await healthRes.json().catch(() => ({ ok: false })) : { ok: false };
      state.stats = statsRes ? await statsRes.json().catch(() => ({})) : {};
      state.distributions = distRes ? (await distRes.json().catch(() => ({ distributions: [] }))).distributions || [] : [];
      state.revalidations = revalidationRes ? (await revalidationRes.json().catch(() => ({ revalidations: [] }))).revalidations || [] : [];
      state.hostMappings = hostMappingsRes ? (await hostMappingsRes.json().catch(() => ({ mappings: {} }))).mappings || {} : {};
      render();
    }

    el('#refreshBtn').addEventListener('click', load);
    el('#siteSwitcher').addEventListener('change', (event) => setActiveSite(event.currentTarget.value));

    el('#mapAllHostsBtn')?.addEventListener('click', async () => {
      const btn = el('#mapAllHostsBtn');
      btn.disabled = true;
      btn.textContent = 'Mapping...';
      try {
        const response = await fetch('/host-mappings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Bulk mapping failed');
        await load();
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Map All';
      }
    });

    el('#exportDistributionsBtn')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/distributions/export');
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'distributions.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        alert('Export failed: ' + err.message);
      }
    });

    el('#importDistributionsBtn')?.addEventListener('click', () => {
      el('#importFileInput')?.click();
    });

    el('#importFileInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const distributions = Array.isArray(parsed.distributions) ? parsed.distributions : (Array.isArray(parsed) ? parsed : []);
        if (!distributions.length) throw new Error('No distributions found in selected file.');
        const replace = confirm('Found ' + distributions.length + ' distribution(s).\\nClick OK to MERGE with existing sites, or Cancel to REPLACE all existing sites.');
        const res = await fetch('/distributions/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ distributions, replace: !replace }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Import failed');
        alert('Successfully imported ' + result.imported + ' distribution(s)!');
        await load();
      } catch (err) {
        alert('Import failed: ' + err.message);
      } finally {
        e.target.value = '';
      }
    });
    el('#siteSearch').addEventListener('input', (event) => {
      state.searchQuery = event.currentTarget.value;
      renderDistributionList();
      setActiveSite(state.activeDistributionId);
    });
    el('#copySiteIdBtn').addEventListener('click', async () => {
      if (!state.activeDistributionId) return;
      await copy(state.activeDistributionId);
      el('#copySiteIdBtn').textContent = 'Copied';
      setTimeout(() => (el('#copySiteIdBtn').textContent = 'Copy ID'), 900);
    });
    el('#copyApiBtn').addEventListener('click', async () => {
      await copy('http://cowfront.local:' + adminPort + '/');
      el('#copyApiBtn').textContent = 'Copied';
      setTimeout(() => (el('#copyApiBtn').textContent = 'Copy admin URL'), 900);
    });

    const createDialog = el('#createSiteDialog');
    const closeCreateDialog = () => {
      createDialog.close();
      el('#createForm').reset();
      el('#createForm').querySelector('[name="compress"]').checked = true;
    };
    el('#openCreateDialogBtn').addEventListener('click', () => {
      createDialog.showModal();
      el('#createForm').querySelector('[name="origin"]').focus();
    });
    el('#closeCreateDialogBtn').addEventListener('click', closeCreateDialog);
    el('#cancelCreateDialogBtn').addEventListener('click', closeCreateDialog);
    createDialog.addEventListener('click', (event) => {
      if (event.target === createDialog) closeCreateDialog();
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
      const created = await r.json();
      state.activeDistributionId = created.id;
      form.reset();
      form.querySelector('[name="compress"]').checked = true;
      await load();
      createDialog.close();
    });

    const editDialog = el('#editSiteDialog');
    const closeEditDialog = () => {
      editDialog.close();
      el('#editForm').reset();
    };
    el('#closeEditDialogBtn').addEventListener('click', closeEditDialog);
    el('#cancelEditDialogBtn').addEventListener('click', closeEditDialog);
    editDialog.addEventListener('click', (event) => {
      if (event.target === editDialog) closeEditDialog();
    });

    function openEditDialog(id) {
      const d = state.distributions.find((item) => item.id === id);
      if (!d) return;
      el('#editDistId').value = d.id;
      el('#editDistIdDisplay').value = d.id;
      el('#editSiteSubtitle').textContent = 'Updating ' + d.id + ' (' + d.domainName + ')';
      el('#editDomain').value = d.domainName || '';
      el('#editOrigin').value = d.origin?.domainName || '';
      el('#editOriginPath').value = d.origin?.originPath || '';
      el('#editDefaultTtl').value = d.defaultCacheBehavior?.defaultTtl ?? 86400;
      el('#editMinTtl').value = d.defaultCacheBehavior?.minTtl ?? 0;
      el('#editMaxTtl').value = d.defaultCacheBehavior?.maxTtl ?? 31536000;
      el('#editEnabled').checked = d.enabled !== false;
      el('#editCompress').checked = d.defaultCacheBehavior?.compress !== false;
      el('#editForwardQuery').checked = !!d.defaultCacheBehavior?.forwardQueryString;
      el('#editComment').value = d.comment || '';
      editDialog.showModal();
      el('#editDomain').focus();
    }

    el('#editSiteBtn').addEventListener('click', () => {
      if (state.activeDistributionId) openEditDialog(state.activeDistributionId);
    });

    el('#editForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const id = el('#editDistId').value;
      const data = Object.fromEntries(new FormData(form).entries());
      const body = {
        domainName: data.domain?.trim() || undefined,
        enabled: form.querySelector('#editEnabled').checked,
        comment: data.comment || '',
        origin: {
          domainName: data.origin?.trim(),
          originPath: data['origin-path'] !== undefined ? data['origin-path'].trim() : '',
        },
        defaultCacheBehavior: {
          compress: form.querySelector('#editCompress').checked,
          forwardQueryString: form.querySelector('#editForwardQuery').checked,
          defaultTtl: data['default-ttl'] !== '' && !isNaN(Number(data['default-ttl'])) ? Number(data['default-ttl']) : undefined,
          minTtl: data['min-ttl'] !== '' && !isNaN(Number(data['min-ttl'])) ? Number(data['min-ttl']) : undefined,
          maxTtl: data['max-ttl'] !== '' && !isNaN(Number(data['max-ttl'])) ? Number(data['max-ttl']) : undefined,
        },
      };
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const r = await fetch('/distributions/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || 'update failed');
        }
        editDialog.close();
        await load();
        setActiveSite(id);
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });

    el('#functionDistribution').addEventListener('change', (event) => setActiveSite(event.currentTarget.value));
    el('#functionEventType').addEventListener('change', updateFunctionHint);

    el('#functionFile').addEventListener('change', async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      el('#functionName').value = file.name;
      el('#functionCode').value = await file.text();
      el('#functionSaveStatus').textContent = 'Loaded ' + file.name + '. Review it, then save and associate.';
    });

    el('#loadHtmlExampleBtn').addEventListener('click', () => {
      el('#functionEventType').value = 'viewerRequest';
      el('#functionName').value = 'remove-html-extension.js';
      el('#functionCode').value = removeHtmlTemplate;
      el('#functionTestPath').value = '/about.html?lang=en';
      el('#functionSaveStatus').textContent = 'Example loaded. Click Save & associate, then run the test.';
      updateFunctionHint();
    });

    el('#functionForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const distribution = el('#functionDistribution').value;
      const button = el('#saveFunctionBtn');
      const status = el('#functionSaveStatus');
      if (!distribution) return (status.textContent = 'Create or select a distribution first.');
      button.disabled = true;
      button.textContent = 'Saving...';
      try {
        const r = await fetch('/distributions/' + encodeURIComponent(distribution) + '/functions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            eventType: el('#functionEventType').value,
            name: el('#functionName').value.trim() || 'cloudfront-function.js',
            code: el('#functionCode').value,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'function save failed');
        status.textContent = 'Saved and associated: ' + data.functionPath;
        await load();
      } catch (error) {
        status.textContent = 'Error: ' + error.message;
      } finally {
        button.disabled = false;
        button.textContent = 'Save & associate';
      }
    });

    el('#functionTestForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const distribution = el('#functionDistribution').value;
      const output = el('#functionTestOutput');
      const button = el('#runFunctionBtn');
      if (!distribution) {
        output.hidden = false;
        output.textContent = 'Create or select a distribution first.';
        return;
      }
      button.disabled = true;
      button.textContent = 'Running...';
      output.hidden = false;
      output.textContent = 'Sending request through CowFront...';
      try {
        const r = await fetch('/distributions/' + encodeURIComponent(distribution) + '/function-test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: el('#functionTestPath').value.trim() || '/' }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'function test failed');
        showFunctionTest(data);
        await load();
      } catch (error) {
        output.textContent = 'Test error: ' + error.message;
      } finally {
        button.disabled = false;
        button.textContent = 'Run through local CDN';
      }
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

    const auditDialog = el('#auditDialog');
    const closeAuditDialog = () => auditDialog?.close();
    el('#closeAuditDialogBtn')?.addEventListener('click', closeAuditDialog);
    auditDialog?.addEventListener('click', (e) => { if (e.target === auditDialog) closeAuditDialog(); });

    el('#auditSetupBtn')?.addEventListener('click', async () => {
      if (!auditDialog) return;
      const content = el('#auditContent');
      content.innerHTML = '<div class="hint">Running audit checks across Node.js, MinIO, Caddy, hosts file, and distributions...</div>';
      auditDialog.showModal();
      try {
        const res = await fetch('/audit');
        const data = await res.json();
        const sum = data.summary || {};
        const isOk = data.ok;
        const statusClass = isOk ? 'good' : (sum.fail > 0 ? 'bad' : 'warn');
        let html = \`
          <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:rgba(255,255,255,0.03); border-radius:12px; border:1px solid rgba(255,255,255,0.08);">
            <div>
              <strong style="font-size:15px;">Audit Status: <span class="\${statusClass}">\${isOk ? 'All Systems Operational' : 'Action Required'}</span></strong>
              <div class="hint" style="margin-top:2px;">\${sum.pass || 0} passed, \${sum.warn || 0} warnings, \${sum.fail || 0} failed</div>
            </div>
            <button class="ghost" id="rerunAuditBtn" type="button" style="font-size:12px; padding:5px 12px;">Re-run Audit</button>
          </div>
        \`;

        if (data.recommendations && data.recommendations.length > 0) {
          html += \`
            <div style="background:rgba(255,212,140,0.08); border:1px solid rgba(255,212,140,0.25); border-radius:12px; padding:14px;">
              <h3 style="margin:0 0 10px; font-size:14px; color:var(--warn);">Recommended Actions (from README)</h3>
              <div style="display:grid; gap:10px;">
                \${data.recommendations.map((rec, i) => \`
                  <div style="background:rgba(0,0,0,0.2); padding:10px 12px; border-radius:8px;">
                    <div style="font-size:13px; font-weight:700;">\${i+1}. \${escapeHtml(rec.title)}</div>
                    \${rec.reason ? \`<div class="hint" style="margin:2px 0 6px;">\${escapeHtml(rec.reason)}</div>\` : ''}
                    <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                      <code style="flex:1; background:rgba(255,255,255,0.05); padding:6px 10px; border-radius:6px; font-family:monospace; font-size:12px; overflow-x:auto;">\${escapeHtml(rec.command)}</code>
                      <button class="ghost" type="button" data-copy-cmd="\${escapeHtml(rec.command)}" style="font-size:11px; padding:5px 10px;">Copy</button>
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>
          \`;
        }

        html += \`
          <div style="display:grid; gap:12px; max-height:420px; overflow-y:auto; padding-right:4px;">
            \${(data.categories || []).map((cat) => \`
              <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:12px 14px;">
                <div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin-bottom:8px;">\${escapeHtml(cat.name)}</div>
                <div style="display:grid; gap:6px;">
                  \${(cat.checks || []).map((chk) => {
                    const badgeClass = chk.status === 'pass' ? 'good' : (chk.status === 'fail' ? 'bad' : 'warn');
                    const badgeIcon = chk.status === 'pass' ? '✓' : (chk.status === 'fail' ? '✕' : (chk.status === 'warn' ? '!' : 'ℹ'));
                    return \`
                      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; font-size:13px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.03);">
                        <div>
                          <strong>\${escapeHtml(chk.name)}</strong>
                          <div class="hint" style="margin-top:2px;">\${escapeHtml(chk.message)}</div>
                        </div>
                        <span class="chip \${badgeClass}" style="font-size:11px; padding:2px 8px; flex-shrink:0;">\${badgeIcon} \${chk.status.toUpperCase()}</span>
                      </div>
                    \`;
                  }).join('')}
                </div>
              </div>
            \`).join('')}
          </div>
        \`;


        content.innerHTML = html;

        content.querySelectorAll('[data-copy-cmd]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await copy(btn.dataset.copyCmd);
            btn.textContent = 'Copied!';
            setTimeout(() => (btn.textContent = 'Copy'), 900);
          });
        });

        el('#rerunAuditBtn')?.addEventListener('click', () => el('#auditSetupBtn')?.click());
      } catch (err) {
        content.innerHTML = '<div class="hint" style="color:var(--bad);">Audit failed: ' + escapeHtml(err.message) + '</div>';
      }
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
  for (const d of state.config.distributions) populateFunctionCodeFromDisk(d);
  saveConfig({ distributions: state.config.distributions });
  const caddy = syncCaddyDistributionRoutes(state.config.distributions);
  if (caddy.configured && !caddy.reloaded && caddy.error) {
    console.warn(`[caddy] routes updated but reload failed: ${caddy.error}`);
  }
  setTimeout(() => (state.suppressReload = false), 400);
}

// ----------------------------------------------------------------------------- serve
function serve() {
  const cfg = loadConfig();
  const distributions = cfg.distributions.map(normalizeDistribution);
  restoreFunctionFiles(distributions);
  for (const d of distributions) populateFunctionCodeFromDisk(d);

  const state = {
    config: { distributions },
    cache: new Cache(CACHE_MAX),
    metrics: { requests: 0, hits: 0, misses: 0, refreshHits: 0 },
    revalidations: [],
    suppressReload: false,
  };

  // persist normalized form once so IDs/domains are stable on disk
  saveConfig({ distributions: state.config.distributions });
  syncCaddyDistributionRoutes(state.config.distributions, true);

  if (existsSync(CONFIG_PATH)) {
    let t;
    watch(CONFIG_PATH, () => {
      if (state.suppressReload) return;
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          const c = loadConfig();
          const nextDistributions = c.distributions.map(normalizeDistribution);
          restoreFunctionFiles(nextDistributions);
          for (const d of nextDistributions) populateFunctionCodeFromDisk(d);
          state.config.distributions = nextDistributions;
          syncCaddyDistributionRoutes(state.config.distributions);
          console.log('[localfront] config reloaded — %d distribution(s)', state.config.distributions.length);
        } catch (e) {
          console.error('[localfront] reload failed:', e.message);
        }
      }, 150);
    });
  }

  const proxy = http.createServer((req, res) =>
    handleProxy(req, res, state).catch((e) => {
      try { sendPlain(res, 500, `CowFront error: ${e.message}\n`); } catch {}
    })
  );
  proxy.listen(PROXY_PORT, () =>
    console.log(`CowFront proxy  ->  http://localhost:${PROXY_PORT}`)
  );

  const admin = http.createServer((req, res) =>
    handleAdmin(req, res, state).catch((e) => {
      try { sendJson(res, 500, { error: e.message }); } catch {}
    })
  );
  admin.listen(ADMIN_PORT, () =>
    console.log(`CowFront admin  ->  http://cowfront.local/  (direct: http://localhost:${ADMIN_PORT})`)
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

  const mapped = mappedLoopbackHostnames();
  const unmapped = state.config.distributions
    .map((d) => String(d.domainName || '').trim().toLowerCase())
    .filter((h) => validHostname(h) && !isBuiltInLocalHostname(h) && !mapped.has(h));
  if (unmapped.length) {
    console.log(`\n[hosts] Note: ${unmapped.length} distribution domain(s) not mapped in your hosts file:`);
    console.log(`  ${unmapped.join(', ')}`);
    console.log(`  Run "npm run setup" or click "Map All" at http://cowfront.local/ to map them.\n`);
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
  if (f.comment !== undefined) d.comment = f.comment;
  if (!existing && f.id) d.id = f.id;
  if (f.domain) d.domainName = f.domain;
  if (f['default-ttl'] !== undefined) d.defaultCacheBehavior.defaultTtl = +f['default-ttl'];
  if (f['min-ttl'] !== undefined) d.defaultCacheBehavior.minTtl = +f['min-ttl'];
  if (f['max-ttl'] !== undefined) d.defaultCacheBehavior.maxTtl = +f['max-ttl'];
  if (f.compress === false) d.defaultCacheBehavior.compress = false;
  if (f.compress === true) d.defaultCacheBehavior.compress = true;
  if (f['forward-query'] !== undefined) d.defaultCacheBehavior.forwardQueryString = !!f['forward-query'];
  if (f.enabled !== undefined) d.enabled = f.enabled !== 'false' && f.enabled !== false;
  d.defaultCacheBehavior.functionAssociations = d.defaultCacheBehavior.functionAssociations || {};
  if (f['viewer-request-function'] !== undefined) {
    d.defaultCacheBehavior.functionAssociations.viewerRequest = f['viewer-request-function'] === false
      ? '' : String(f['viewer-request-function']);
  }
  if (f['viewer-response-function'] !== undefined) {
    d.defaultCacheBehavior.functionAssociations.viewerResponse = f['viewer-response-function'] === false
      ? '' : String(f['viewer-response-function']);
  }
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
  const functions = d.defaultCacheBehavior.functionAssociations || {};
  console.log(`  Functions   viewer-request=${functions.viewerRequest || '(none)'} viewer-response=${functions.viewerResponse || '(none)'}`);
  console.log(`  Enabled     ${d.enabled}`);
  console.log(`  Example     curl -H "X-Distribution-Id: ${d.id}" http://localhost:${PROXY_PORT}/<object-key>`);
}

const HELP = `CowFront — local CloudFront-like CDN for MinIO / any HTTP origin

Usage:
  cowfront serve
  cowfront audit (or doctor) [--json]
  cowfront create-distribution --origin <url> [--origin-path /bucket] [options]
  cowfront list-distributions
  cowfront get-distribution <id>
  cowfront update-distribution <id> [options]
  cowfront delete-distribution <id>
  cowfront create-invalidation <id> --paths "/*" ["/img/*" ...]
  cowfront stats
  cowfront export [file.json]
  cowfront import <file.json> [--replace]
  cowfront setup-hosts (or map-hosts)

(or: node localfront.mjs <command>)

Options for create/update:
  --origin <url>          origin endpoint, e.g. http://localhost:9000 (MinIO)
  --origin-path <path>    prepended to every request, e.g. /assets (the bucket)
  --domain <hostname>     friendly viewer hostname, e.g. site.local
  --default-ttl <sec>     TTL when origin sends no cache headers (default 86400)
  --min-ttl <sec>         floor TTL (default 0)
  --max-ttl <sec>         ceiling TTL (default 31536000)
  --no-compress           disable gzip/br compression
  --forward-query         include query string in the cache key
  --viewer-request-function <file>   run an AWS-style viewer-request function
  --viewer-response-function <file>  run an AWS-style viewer-response function
  --no-viewer-request-function       remove the viewer-request association
  --no-viewer-response-function      remove the viewer-response association
  --comment "<text>"      free-text comment
  --id <id>               force a specific distribution id

Env:
  LOCALFRONT_PORT (8080)  LOCALFRONT_ADMIN_PORT (5744)  LOCALFRONT_CONFIG (./distributions.json)
  LOCALFRONT_FUNCTION_TIMEOUT_MS (100)

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

    case 'audit':
    case 'doctor': {
      const jsonMode = f.json || f._.includes('--json');
      const result = await runAudit({
        appRoot: APP_ROOT,
        configPath: CONFIG_PATH,
        hostsPath: HOSTS_PATH,
        caddyfilePath: CADDYFILE_PATH,
      });
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const useColors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
        console.log(formatAuditReport(result, useColors));
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }

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
      if (!up) console.log('\n(server not running — start it with: cowfront serve)');
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
      const flags = { ...f };
      delete flags.id;
      if (up) updated = await api('PUT', `/distributions/${id}`, distFromFlags(flags));
      else {
        const cfg = loadConfig();
        cfg.distributions = cfg.distributions.map(normalizeDistribution);
        const idx = cfg.distributions.findIndex((x) => x.id.toLowerCase() === id.toLowerCase());
        if (idx === -1) return console.error(`distribution ${id} not found`);
        updated = normalizeDistribution(distFromFlags(flags, cfg.distributions[idx]));
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
      if (!up) return console.error('server must be running to invalidate cache (cowfront serve)');
      let paths = [];
      if (Array.isArray(f.paths)) paths = f.paths;
      else if (typeof f.paths === 'string') paths = [f.paths];
      if (f._.length > 1) paths = paths.concat(f._.slice(1));
      if (!paths.length) paths = ['/*'];
      const r = await api('POST', `/distributions/${id}/invalidations`, { paths });
      console.log(`Invalidation ${r.id}: removed ${r.invalidated} cached object(s) for ${paths.join(', ')}`);
      return;
    }

    case 'stat':
    case 'stats': {
      if (!up) return console.error('server not running');
      console.log(JSON.stringify(await api('GET', '/stats'), null, 2));
      return;
    }

    case 'export': {
      const target = f._[0];
      const cfg = loadConfig();
      const dists = cfg.distributions.map(normalizeDistribution);
      for (const d of dists) populateFunctionCodeFromDisk(d);
      const output = JSON.stringify({ distributions: dists }, null, 2);
      if (target) {
        writeFileSync(path.resolve(process.cwd(), target), output + '\n', 'utf8');
        console.log(`Exported ${dists.length} distribution(s) to ${target}`);
      } else {
        console.log(output);
      }
      return;
    }

    case 'import': {
      const source = f._[0];
      if (!source) {
        console.error('usage: cowfront import <file.json> [--replace]');
        process.exitCode = 1;
        return;
      }
      const resolved = path.resolve(process.cwd(), source);
      if (!existsSync(resolved)) {
        console.error(`file not found: ${source}`);
        process.exitCode = 1;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(resolved, 'utf8'));
      } catch (e) {
        console.error(`invalid JSON in ${source}: ${e.message}`);
        process.exitCode = 1;
        return;
      }
      const incoming = (Array.isArray(parsed.distributions) ? parsed.distributions : (Array.isArray(parsed) ? parsed : []))
        .map(normalizeDistribution);
      if (!incoming.length) {
        console.error('no distributions found in file');
        process.exitCode = 1;
        return;
      }

      if (up) {
        const res = await api('POST', '/distributions/import', { distributions: incoming, replace: !!f.replace });
        console.log(`Imported ${res.imported} distribution(s) (${res.restoredFunctions || 0} function file(s) restored).`);
      } else {
        const cfg = loadConfig();
        const existing = f.replace ? [] : cfg.distributions.map(normalizeDistribution);
        let count = 0;
        for (const item of incoming) {
          const idx = existing.findIndex((d) => d.id.toLowerCase() === item.id.toLowerCase());
          if (idx !== -1) existing[idx] = item;
          else existing.push(item);
          count++;
        }
        const restored = restoreFunctionFiles(existing);
        for (const d of existing) populateFunctionCodeFromDisk(d);
        saveConfig({ distributions: existing });
        syncCaddyDistributionRoutes(existing, false);
        console.log(`Imported ${count} distribution(s) (${restored} function file(s) restored).`);
        console.log('\nTo map domain names to your hosts file, run: npm run setup');
      }
      return;
    }

    case 'setup-hosts':
    case 'map-hosts': {
      const scriptPath = path.join(APP_ROOT, 'scripts', 'setup-hosts.mjs');
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: APP_ROOT,
        env: process.env,
        stdio: 'inherit',
      });
      process.exitCode = result.status ?? 0;
      return;
    }

    case 'caddy': {
      const scriptPath = path.join(APP_ROOT, 'scripts', 'caddy.mjs');
      const result = spawnSync(process.execPath, [scriptPath, ...rest], {
        cwd: APP_ROOT,
        env: process.env,
        stdio: 'inherit',
      });
      process.exitCode = result.status ?? 0;
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
