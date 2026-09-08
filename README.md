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
npm run minio:up
```

The startup script scans ports `9000` and `9001` first. If MinIO is already listening, it skips the Compose launch instead of failing. If MinIO is not found, it asks whether Docker Compose should start it. Use `npm run minio:up -- --yes` to start without prompting.

**2. Create a distribution** pointing at the MinIO bucket:

```bash
node localfront.mjs create-distribution \
  --origin http://localhost:9000 \
  --origin-path /assets \
  --default-ttl 3600
```

This prints a CloudFront-style **Distribution ID** (e.g. `E1A2B3C4D5E6F7`) and a domain `e1a2b3c4d5e6f7.localhost`.

### Friendly local hostnames

Install the optional loopback aliases:

```bash
npm run hosts:setup
```

On Windows, run the terminal as Administrator because updating the hosts file requires elevation. The command adds `site.local`, `api.local`, and `app.local` as aliases for `127.0.0.1`. Ports are still part of the URL because hosts files do not route ports:

```text
http://site.local:8080  -> LocalFront
http://api.local:3001   -> API service
http://app.local:3000   -> App service
```

Create a distribution with a friendly viewer hostname:

```bash
node localfront.mjs create-distribution --domain site.local \
  --origin http://localhost:9000 --origin-path /assets
```

Remove the aliases later with `npm run hosts:setup -- --remove`.

Add your own aliases by passing one or more `--map` options. Both `name.local=port` and `name.local:port` are accepted:

```bash
npm run hosts:setup -- --map admin.local=5744 --map shop.local=4173
```

This creates `admin.local` and `shop.local` as loopback aliases, used as `http://admin.local:5744` and `http://shop.local:4173`.

### Friendly hostname FAQ

**Why does `localhost:8080` work but `site.local:8080` not work?**

On Windows, open PowerShell as Administrator and run:

```powershell
npm run hosts:setup
ipconfig /flushdns
```

Then verify the alias before opening `http://site.local:8080`:

```powershell
Resolve-DnsName site.local
Test-NetConnection site.local -Port 8080
```

The hosts file maps names to `127.0.0.1`; the port remains part of the URL.

### MinIO anonymous access FAQ

**How do I make the LocalFront origin readable without authentication?**

Set an anonymous read-only policy on the MinIO bucket prefix. Keep the bucket and prefix as variables so this works with any bucket layout:

```bash
MINIO_BUCKET=uforge-local
MINIO_PREFIX=data/site.local

mc alias set local http://localhost:9000 minioadmin minioadmin
mc anonymous set download "local/$MINIO_BUCKET/$MINIO_PREFIX"
```

If `mc` is not installed on the host, run the setup through the Compose helper container:

```bash
docker compose run --rm --entrypoint sh createbuckets -c \
  "mc alias set local http://minio:9000 minioadmin minioadmin && mc anonymous set download local/$MINIO_BUCKET/$MINIO_PREFIX"
```

Verify the policy and an object:

```bash
mc anonymous get "local/$MINIO_BUCKET/$MINIO_PREFIX"
curl -I "http://localhost:9000/$MINIO_BUCKET/$MINIO_PREFIX/example.png"
```

Use `download` for public reads. It does not grant anonymous upload or delete access. MinIO anonymous policies can target a bucket or a bucket prefix. [`mc anonymous set`](https://docs.min.io/aistor/reference/cli/mc-anonymous/mc-anonymous-set/)

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

For a MinIO bucket with an object prefix, include both values in the origin path. For example, if the bucket is `uforge-local` and the objects are under `data/site.local/`, LocalFront requests `/uforge-local/data/site.local/<object-key>` from MinIO:

```bash
MINIO_BUCKET=uforge-local
MINIO_PREFIX=data/site.local
node localfront.mjs create-distribution \
  --domain site.local \
  --origin http://localhost:9000 \
  --origin-path "/$MINIO_BUCKET/$MINIO_PREFIX"
```

The bucket and prefix are only command/config values; LocalFront does not hard-code either one. To repair an existing distribution, use the same variables with `update-distribution`:

```bash
node localfront.mjs update-distribution EM5T9ZZLUF20OC \
  --origin-path "/$MINIO_BUCKET/$MINIO_PREFIX"
```

Use the MinIO API port `9000` as the origin. Port `9001` is only the MinIO web console.

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
| GET | `/` | small admin dashboard UI |
| GET | `/distributions` | list |
| POST | `/distributions` | create |
| GET | `/distributions/:id` | get |
| PUT | `/distributions/:id` | update |
| DELETE | `/distributions/:id` | delete |
| POST | `/distributions/:id/invalidations` | `{ "paths": ["/*"] }` |
| GET | `/stats` | cache size + hit/miss counters |
| GET | `/health` | liveness |

Open `http://localhost:5744/` in a browser to use the dashboard for quick distribution management and cache invalidation.

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

### Content update cycle

When you overwrite an existing object such as `index.html` in MinIO, LocalFront keeps serving the cached response until its TTL expires, just like a CloudFront distribution. After expiry, it revalidates the object with MinIO: an unchanged object returns `X-Cache: RefreshHit`, while a changed object is fetched and returned as `X-Cache: Miss`.

To publish the new object immediately, invalidate that path after uploading it:

```bash
node localfront.mjs create-invalidation EM5T9ZZLUF20OC --paths "/index.html"
```

The next request through `http://site.local:8080/index.html` fetches the new content. Use `--paths "/*"` to invalidate the whole distribution. Invalidation actions and automatic TTL revalidations are shown in the dashboard's Revalidation history. You can choose a shorter default TTL when creating or updating a distribution, for example `--default-ttl 300` for five-minute revalidation.

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
