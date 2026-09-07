# LocalFront

A local, **CloudFront-like CDN emulator** that sits in front of **MinIO** (or any HTTP origin) on your machine. Same mental model as CloudFront — distributions, an ID per distribution, an origin, cache behaviors, TTLs, invalidations — but everything runs on `localhost` with zero dependencies.

It's the CDN-layer companion to using MinIO as your local S3: MinIO answers the S3 API, LocalFront does the edge caching in front of it.

```
browser ──▶ LocalFront (:8080)  ──▶  MinIO (:9000)  [bucket = origin path]
             caching, TTL,              S3 objects
             compression,
             invalidation
```

## Requirements

- Node.js >= 18 (uses built-in `fetch`, `zlib`, `crypto` — no npm install needed)
- MinIO (via the included `docker-compose.yml`) or any HTTP origin

## Quickstart

**1. Start MinIO** (creates a public-read `assets` bucket + a sample `hello.txt`):

```bash
docker compose up -d
```

**2. Create a distribution** pointing at the MinIO bucket:

```bash
node localfront.mjs create-distribution \
  --origin http://localhost:9000 \
  --origin-path /assets \
  --default-ttl 3600
```

This prints a CloudFront-style **Distribution ID** (e.g. `E1A2B3C4D5E6F7`) and a domain `e1a2b3c4d5e6f7.localhost`.

**3. Start the CDN:**

```bash
node localfront.mjs serve
```

**4. Request an object through the CDN:**

```bash
# by header (easiest for curl)
curl -i -H "X-Distribution-Id: E1A2B3C4D5E6F7" http://localhost:8080/hello.txt

# or by subdomain (works in browsers — *.localhost resolves to 127.0.0.1)
curl -i http://e1a2b3c4d5e6f7.localhost:8080/hello.txt
```

First request → `X-Cache: Miss from LocalFront`. Second → `X-Cache: Hit from LocalFront` with an `Age` header. That's the CDN cache working.

## How a request maps to MinIO

```
GET http://localhost:8080/img/logo.png   (distribution origin-path = /assets)
        │
        ▼
GET http://localhost:9000/assets/img/logo.png   (MinIO path-style: /<bucket>/<key>)
```

`--origin-path` is your bucket (CloudFront calls this the *Origin Path*). The object key follows.

> MinIO note: LocalFront fetches over anonymous HTTP, so the bucket/prefix must be readable. The compose file runs `mc anonymous set download local/assets` for you. This mirrors a public origin; if you need signed access instead, that's an extension point (see below).

## Routing a request to a distribution

Any of these select the distribution (checked in this order):

| Method | Example |
|---|---|
| Host subdomain | `http://<id>.localhost:8080/key` |
| Header | `curl -H "X-Distribution-Id: <id>" http://localhost:8080/key` |
| Path prefix | `http://localhost:8080/_d/<id>/key` |
| Single default | if only one distribution exists, it's used automatically |

## CLI

```
node localfront.mjs serve
node localfront.mjs create-distribution --origin <url> [--origin-path /bucket] [options]
node localfront.mjs list-distributions
node localfront.mjs get-distribution <id>
node localfront.mjs update-distribution <id> [options]
node localfront.mjs delete-distribution <id>
node localfront.mjs create-invalidation <id> --paths "/*" ["/img/*" ...]
node localfront.mjs stats
```

**Options** (create/update): `--origin`, `--origin-path`, `--default-ttl`, `--min-ttl`, `--max-ttl`, `--no-compress`, `--forward-query`, `--comment`, `--id`.

The CLI talks to the running server's admin API when it's up; otherwise it edits `distributions.json` directly (so you can pre-provision before starting). The server watches that file and hot-reloads.

## Invalidations

```bash
node localfront.mjs create-invalidation E1A2B3C4D5E6F7 --paths "/*"
node localfront.mjs create-invalidation E1A2B3C4D5E6F7 --paths "/img/*"
```

Patterns support `*` wildcards, exactly like CloudFront invalidation paths.

## Admin API

Runs on `http://localhost:5744`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/distributions` | list |
| POST | `/distributions` | create |
| GET | `/distributions/:id` | get |
| PUT | `/distributions/:id` | update |
| DELETE | `/distributions/:id` | delete |
| POST | `/distributions/:id/invalidations` | `{ "paths": ["/*"] }` |
| GET | `/stats` | cache size + hit/miss counters |
| GET | `/health` | liveness |

## CloudFront concept mapping

| CloudFront | LocalFront |
|---|---|
| Distribution | entry in `distributions.json` |
| Distribution ID | `E` + 13 chars (generated) |
| `xxxx.cloudfront.net` | `<id>.localhost:8080` |
| Origin domain | `origin.domainName` (e.g. `http://localhost:9000`) |
| Origin path | `origin.originPath` (your MinIO bucket) |
| Min/Default/Max TTL | `defaultCacheBehavior.{minTtl,defaultTtl,maxTtl}` |
| Compress objects automatically | `compress` (gzip/br on the fly) |
| Cache key: query strings | `forwardQueryString` |
| Cache key: headers | `cacheKeyHeaders` |
| Invalidations | `create-invalidation` / admin endpoint |
| `X-Cache`, `Age`, `Via`, `X-Amz-Cf-Id` | emulated response headers |

## Caching behavior (what it emulates)

- Honors origin `Cache-Control` (`s-maxage` > `max-age`) and `Expires`, clamped to min/max TTL.
- Falls back to **Default TTL** when the origin sends no caching headers (just like CloudFront).
- Respects `no-store` / `private` (never cached).
- **Stale revalidation:** when a cached object expires, LocalFront revalidates with `If-None-Match` / `If-Modified-Since`; a `304` refreshes the TTL and serves the cached body as `X-Cache: RefreshHit`.
- Caches `GET`/`HEAD` by default; `Range` requests pass through uncached.
- In-memory LRU cache (default 5000 entries, `LOCALFRONT_CACHE_MAX`).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `LOCALFRONT_PORT` | `8080` | proxy (CDN) port |
| `LOCALFRONT_ADMIN_PORT` | `5744` | admin API port |
| `LOCALFRONT_CONFIG` | `./distributions.json` | distributions file |
| `LOCALFRONT_CACHE_MAX` | `5000` | max cached objects (LRU) |

## Not included (intentional extension points)

This emulates the **caching CDN + control plane**, which is the 90% case for local dev. It does *not* implement, but is structured to let you add:

- **Signed URLs / signed cookies** — verify in `handleProxy` before the cache lookup.
- **CloudFront Functions / Lambda@Edge** — a viewer-request hook is a natural insert in `handleProxy` before building the origin URL; keep user code sandboxed if you go there.
- **Origin Access Control (OAC)** — swap the plain `fetch` in `handleProxy` for a SigV4-signed request to a private MinIO bucket.
- **Multiple cache behaviors per path pattern** — `defaultCacheBehavior` is a single behavior today; add an ordered `cacheBehaviors[]` matched by path.

## Files

- `localfront.mjs` — the whole tool (server + CLI), zero deps
- `docker-compose.yml` — MinIO + auto-created public `assets` bucket
- `distributions.json` — created at runtime; your distributions
- `fake-origin.mjs` — a tiny origin used only for smoke-testing without MinIO
