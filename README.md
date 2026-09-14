# CowFront

A local, **CloudFront-like CDN emulator** that sits in front of **MinIO** (or any HTTP origin) on your machine. Same mental model as CloudFront — distributions, an ID per distribution, an origin, cache behaviors, TTLs, invalidations — but everything runs on `localhost` with zero dependencies.

It's the CDN-layer companion to using MinIO as your local S3: MinIO answers the S3 API, CowFront does the edge caching in front of it.

```
browser ──▶ CowFront (:8080)  ──▶  MinIO (:9000)  [bucket = origin path]
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

To make every object under a bucket prefix anonymously downloadable, run:

```bash
npm run minio:public -- --bucket uforge-local --prefix data
```

This applies the read-only download policy to `local/uforge-local/data/*`. The bucket is never hard-coded; use any bucket and prefix you need. The equivalent environment-variable form is `MINIO_BUCKET=uforge-local MINIO_PREFIX=data npm run minio:up -- --yes`, which applies the policy during Compose startup.

**2. Create a distribution** pointing at the MinIO bucket:

```bash
cowfront create-distribution \
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

Running `npm install` in the CowFront project, installing CowFront globally, or running `npm run setup` also starts this host setup automatically. On Windows, approve the Administrator prompt so the protected hosts file can be updated. The setup adds `cowfront.local`, `gh-dev.test`, `app.local`, `site.local`, and `api.local` as aliases for `127.0.0.1` and flushes the DNS cache automatically. Hosts files do not route ports, so a port is part of the URL for everything Caddy does not front:

```text
http://cowfront.local   -> CowFront admin dashboard (via Caddy)
http://gh-dev.test      -> the project on port 3015 (via Caddy, shared with teammates)
http://app.local        -> the same project, this machine only (via Caddy)
http://site.local:8080  -> CowFront
http://api.local:3001   -> API service
```

Create a distribution with a friendly viewer hostname:

```bash
cowfront create-distribution --domain site.local \
  --origin http://localhost:9000 --origin-path /assets
```

Remove the aliases later with `npm run hosts:setup -- --remove`.

Add your own aliases by passing one or more `--map` options. Both `name.local=port` and `name.local:port` are accepted. The aliases are written and DNS is flushed automatically:

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

**How do I make the CowFront origin readable without authentication?**

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
cowfront serve
# or: npm run serve
```

**4. Request an object through the CDN:**

```bash
# by header (easiest for curl)
curl -i -H "X-Distribution-Id: E1A2B3C4D5E6F7" http://localhost:8080/hello.txt

# or by subdomain (works in browsers — *.localhost resolves to 127.0.0.1)
curl -i http://e1a2b3c4d5e6f7.localhost:8080/hello.txt
```

First request → `X-Cache: Miss from CowFront`. Second → `X-Cache: Hit from CowFront` with an `Age` header. That's the CDN cache working.

## How a request maps to MinIO

```
GET http://localhost:8080/img/logo.png   (distribution origin-path = /assets)
        │
        ▼
GET http://localhost:9000/assets/img/logo.png   (MinIO path-style: /<bucket>/<key>)
```

`--origin-path` is your bucket (CloudFront calls this the *Origin Path*). The object key follows.

For a MinIO bucket with an object prefix, include both values in the origin path. For example, if the bucket is `uforge-local` and the objects are under `data/site.local/`, CowFront requests `/uforge-local/data/site.local/<object-key>` from MinIO:

```bash
MINIO_BUCKET=uforge-local
MINIO_PREFIX=data/site.local
cowfront create-distribution \
  --domain site.local \
  --origin http://localhost:9000 \
  --origin-path "/$MINIO_BUCKET/$MINIO_PREFIX"
```

The bucket and prefix are only command/config values; CowFront does not hard-code either one. To repair an existing distribution, use the same variables with `update-distribution`:

```bash
cowfront update-distribution EM5T9ZZLUF20OC \
  --origin-path "/$MINIO_BUCKET/$MINIO_PREFIX"
```

Use the MinIO API port `9000` as the origin. Port `9001` is only the MinIO web console.

> MinIO note: CowFront fetches over anonymous HTTP, so the bucket/prefix must be readable. The compose file runs `mc anonymous set download local/assets` for you. This mirrors a public origin; if you need signed access instead, that's an extension point (see below).

## Routing a request to a distribution

Any of these select the distribution (checked in this order):

| Method | Example |
|---|---|
| Host subdomain | `http://<id>.localhost:8080/key` |
| Header | `curl -H "X-Distribution-Id: <id>" http://localhost:8080/key` |
| Path prefix | `http://localhost:8080/_d/<id>/key` |
| Single default | if only one distribution exists, it's used automatically |

## CLI

If installed globally or linked (`npm link`), use `cowfront <command>`. You can also run `node localfront.mjs <command>` or npm scripts like `npm run serve`.

```bash
cowfront serve
cowfront create-distribution --origin <url> [--origin-path /bucket] [options]
cowfront list-distributions
cowfront get-distribution <id>
cowfront update-distribution <id> [options]
cowfront delete-distribution <id>
cowfront create-invalidation <id> --paths "/*" ["/img/*" ...]
cowfront stats
```

**Options** (create/update): `--origin`, `--origin-path`, `--default-ttl`, `--min-ttl`, `--max-ttl`, `--no-compress`, `--forward-query`, `--viewer-request-function`, `--viewer-response-function`, `--comment`, `--id`.

The CLI talks to the running server's admin API when it's up; otherwise it edits `distributions.json` directly (so you can pre-provision before starting). The server watches that file and hot-reloads.

## CloudFront Functions

CowFront can run AWS-style **viewer request** and **viewer response** JavaScript functions on its local CDN path. Point a distribution at the same source files you plan to paste or deploy to CloudFront:

The dashboard at `http://cowfront.local/` has a **Test CloudFront function** form. Select a distribution and event type, upload a `.js` file or paste the source directly, then choose **Save & associate**. Enter a path and choose **Run through local CDN** to see the status, headers, and response body without leaving the dashboard. The built-in **Load remove .html example** button provides an immediately runnable sample.

```powershell
cowfront update-distribution EM5T9ZZLUF20OC `
  --viewer-request-function ./functions/viewer-request.js `
  --viewer-response-function ./functions/viewer-response.js

cowfront serve
curl.exe -i http://site.local/
```

Paths can be absolute or relative to `distributions.json`. Function source is read on every invocation, so saving the file and refreshing the request is enough; the CowFront process does not need to restart. Example functions are in `examples/cloudfront-functions/`.

The equivalent configuration is:

```json
{
  "defaultCacheBehavior": {
    "functionAssociations": {
      "viewerRequest": "./functions/viewer-request.js",
      "viewerResponse": "./functions/viewer-response.js"
    }
  }
}
```

The event uses CloudFront Functions event version `1.0`, including `context`, `viewer`, parsed `querystring`, lowercase `headers`, and separate `cookies`. A viewer-request handler can return a modified request or generate a response. A viewer-response handler runs for cache hits and origin responses and can change status, headers, cookies, or replace the body.

```js
function handler(event) {
  var request = event.request;
  request.uri = request.uri.endsWith('/') ? request.uri + 'index.html' : request.uri;
  request.headers['x-tested-locally'] = { value: 'true' };
  return request;
}
```

Remove an association with `--no-viewer-request-function` or `--no-viewer-response-function`.

### Clean URLs: redirect `.html` paths

The copy-ready example at `examples/cloudfront-functions/remove-html-extension.js` redirects `/about.html` to `/about`, then internally maps the clean `/about` request back to the `/about.html` origin object. Directory paths such as `/docs/` map to `/docs/index.html`. Query parameters, including duplicates, are preserved. Associate it and test without following the redirect:

```powershell
cowfront update-distribution EM5T9ZZLUF20OC `
  --viewer-request-function ./examples/cloudfront-functions/remove-html-extension.js

curl.exe -i "http://site.local/about.html?lang=en"
```

Expected result:

```text
HTTP/1.1 301 Moved Permanently
Location: /about?lang=en
```

Copy and paste this complete function into either a local `.js` file or the AWS CloudFront Functions editor:

```js
function handler(event) {
  var request = event.request;

  // Redirect the old public URL: /about.html -> /about
  if (/\.html$/i.test(request.uri)) {
    var location = request.uri.slice(0, -5);
    var query = [];

    // Keep query parameters, including duplicate values.
    for (var name in request.querystring) {
      var item = request.querystring[name];
      var values = item.multiValue || [item];

      for (var i = 0; i < values.length; i++) {
        query.push(encodeURIComponent(name) + '=' + encodeURIComponent(values[i].value));
      }
    }

    if (query.length) {
      location += '?' + query.join('&');
    }

    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: location },
        'cache-control': { value: 'no-store' }
      }
    };
  }

  // Keep the browser URL clean while fetching the real .html object.
  if (request.uri === '/') {
    request.uri = '/index.html';
  } else if (request.uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!/\.[^/]+$/.test(request.uri)) {
    request.uri += '.html';
  }

  return request;
}
```

Compatibility is intentionally focused on CloudFront Functions' HTTP lifecycle. The local runtime accepts synchronous and async handlers and blocks direct globals for network, filesystem, environment variables, and timers. It does not emulate CloudFront KeyValueStore, AWS compute-utilization scoring, exact runtime quotas, or every runtime 2.0 built-in. Node's `vm` is an isolation aid, not a security boundary, so only run code you trust.

## Invalidations

```bash
cowfront create-invalidation E1A2B3C4D5E6F7 --paths "/*"
cowfront create-invalidation E1A2B3C4D5E6F7 --paths "/img/*"
```

Patterns support `*` wildcards, exactly like CloudFront invalidation paths.

## Admin API

Runs on `http://cowfront.local:5744` (or `http://localhost:5744`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | small admin dashboard UI |
| GET | `/distributions` | list |
| POST | `/distributions` | create |
| GET | `/distributions/:id` | get |
| PUT | `/distributions/:id` | update |
| DELETE | `/distributions/:id` | delete |
| POST | `/distributions/:id/functions` | save pasted/uploaded code and associate it |
| POST | `/distributions/:id/function-test` | run a path through the local CDN and return the result |
| POST | `/distributions/:id/invalidations` | `{ "paths": ["/*"] }` |
| GET | `/stats` | cache size + hit/miss counters |
| GET | `/health` | liveness |

Open `http://cowfront.local/` through Caddy (or `http://localhost:5744/` directly) to use the dashboard for quick distribution management and cache invalidation.
When a distribution uses a friendly hostname that is not mapped to the local loopback address yet, its card shows a **Map hostname** button. On Windows, clicking it may open an Administrator prompt so CowFront can update the protected hosts file; the button disappears after the alias is installed.

### Portless local hostnames with Caddy

Caddy owns port 80 and routes by hostname, so local URLs need no port suffix:

```text
http://cowfront.local -> 127.0.0.1:5744   CowFront's dashboard, this machine only
http://gh-dev.test    -> 127.0.0.1:3015   shared with other machines on the LAN
http://app.local      -> 127.0.0.1:3015   the same project, kept for this machine
http://<this-ip>/     -> 127.0.0.1:3015   same destination, for clients with no hosts entry
```

The dashboard and the shared project sit behind one listener, so the split is enforced by a matcher rather than by the socket: `cowfront.local` answers `403` to any client whose address is not `127.0.0.1` or `::1`. `auto_https off` means Caddy makes no ACME or certificate requests, so it sends nothing out of the machine.

Set `LOCALFRONT_CADDY_PORT` to move Caddy off port 80 (the `Caddyfile` and the `caddy:*` scripts both read that variable). Windows Firewall will ask to allow Caddy on first run: allow **Private** networks so teammates can reach `app.local`, and deny **Public**.

Install Caddy per-user with Windows Package Manager, then validate and start it:

```powershell
npm run caddy:install
npm run caddy:check
npm run caddy:activate
```

Only one program can own port 80. On this machine it was held by a Windows portproxy rule (`0.0.0.0:80 -> 127.0.0.1:3015`), run by the IP Helper service — which is why a process listing blames `svchost` rather than naming the real owner. The Windows-only `caddy:activate` command validates the configuration, requests Administrator access, installs the host aliases, removes that portproxy rule, and starts Caddy in its place with logs in `.caddy/`. Caddy's `app.local` and catch-all routes preserve what the rule used to do, and the command restores the original rule if Caddy fails to start. Use these commands afterward:

```powershell
npm run caddy:reload
npm run caddy:stop
```

Creating, updating, or deleting a CowFront distribution automatically regenerates its hostname-specific Caddy route and reloads Caddy. The dashboard's **Map hostname** action handles the matching hosts-file alias, so a new friendly hostname works without manually editing the Caddyfile. CowFront generates exact hostname routes instead of a broad `*.local` rule, preserving routes owned by other tools.

### Sharing the project with teammates

The shared name is **`gh-dev.test`**. `.test` is reserved by RFC 6761 and never resolves on the public internet, which makes it safe for a local tool. `app.local` still works on this machine, but do not hand it to teammates: `.local` is the mDNS namespace (RFC 6762) and collides with Bonjour on macOS.

A hostname only reaches Caddy if it resolves on the *visitor's* machine — this is DNS, not something Caddy can configure. Print the instructions to send them:

```bash
npm run share
```

That reports this machine's LAN address, checks that Caddy and the project are actually running, and prints a copy-pasteable hosts-file line for Windows and macOS/Linux. Teammates who would rather not edit a file can use the bare IP, which the catch-all route serves.

If a teammate sees `DNS_PROBE_FINISHED_NXDOMAIN`, the name did not resolve and no packet ever reached this machine — they are missing the hosts entry. A firewall or port problem looks different: `ERR_CONNECTION_TIMED_OUT` or `ERR_CONNECTION_REFUSED`.

**Hosts entries are pinned to an IP.** If this machine's address is from DHCP it can change, and every teammate's entry breaks at once. Re-run `npm run share` and send the new line, or ask whoever runs the network for a DHCP reservation. A DNS record on the network's own resolver is the durable fix once one is available — Caddy then needs only the new hostname added to its site block.

## CloudFront concept mapping

| CloudFront | CowFront |
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
| Function associations | `defaultCacheBehavior.functionAssociations.{viewerRequest,viewerResponse}` |
| Invalidations | `create-invalidation` / admin endpoint |
| `X-Cache`, `Age`, `Via`, `X-Amz-Cf-Id` | emulated response headers |

## Caching behavior (what it emulates)

- Honors origin `Cache-Control` (`s-maxage` > `max-age`) and `Expires`, clamped to min/max TTL.
- Falls back to **Default TTL** when the origin sends no caching headers (just like CloudFront).
- Respects `no-store` / `private` (never cached).
- **Stale revalidation:** when a cached object expires, CowFront revalidates with `If-None-Match` / `If-Modified-Since`; a `304` refreshes the TTL and serves the cached body as `X-Cache: RefreshHit`.
- Caches `GET`/`HEAD` by default; `Range` requests pass through uncached.
- In-memory LRU cache (default 5000 entries, `LOCALFRONT_CACHE_MAX`).

### Content update cycle

When you overwrite an existing object such as `index.html` in MinIO, CowFront keeps serving the cached response until its TTL expires, just like a CloudFront distribution. After expiry, it revalidates the object with MinIO: an unchanged object returns `X-Cache: RefreshHit`, while a changed object is fetched and returned as `X-Cache: Miss`.

To publish the new object immediately, invalidate that path after uploading it:

```bash
cowfront create-invalidation EM5T9ZZLUF20OC --paths "/index.html"
```

The next request through `http://site.local:8080/index.html` fetches the new content. Use `--paths "/*"` to invalidate the whole distribution. Invalidation actions and automatic TTL revalidations are shown in the dashboard's Revalidation history. You can choose a shorter default TTL when creating or updating a distribution, for example `--default-ttl 300` for five-minute revalidation.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `LOCALFRONT_PORT` | `8080` | proxy (CDN) port |
| `LOCALFRONT_ADMIN_PORT` | `5744` | admin API port |
| `LOCALFRONT_CONFIG` | `./distributions.json` | distributions file |
| `LOCALFRONT_CACHE_MAX` | `5000` | max cached objects (LRU) |
| `LOCALFRONT_FUNCTION_TIMEOUT_MS` | `100` | local function execution timeout |
| `LOCALFRONT_CADDY_PORT` | `80` | Caddy listener port for the local hostnames |

## Not included (intentional extension points)

This emulates the **caching CDN + control plane**, which is the 90% case for local dev. It does *not* implement, but is structured to let you add:

- **Signed URLs / signed cookies** — verify in `handleProxy` before the cache lookup.
- **Lambda@Edge** — CloudFront Functions viewer hooks are supported; the Node.js Lambda@Edge event model and origin-facing triggers are not.
- **Origin Access Control (OAC)** — swap the plain `fetch` in `handleProxy` for a SigV4-signed request to a private MinIO bucket.
- **Multiple cache behaviors per path pattern** — `defaultCacheBehavior` is a single behavior today; add an ordered `cacheBehaviors[]` matched by path.

## Files

- `localfront.mjs` — the whole tool (server + CLI), zero deps
- `docker-compose.yml` — MinIO + auto-created public `assets` bucket
- `distributions.json` — created at runtime; your distributions
- `fake-origin.mjs` — a tiny origin used only for smoke-testing without MinIO
