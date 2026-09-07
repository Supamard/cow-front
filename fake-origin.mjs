import http from 'node:http';
import { createHash } from 'node:crypto';

let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  const body = `object at ${req.url} :: ${'x'.repeat(200)}`; // compressible text
  const etag = '"' + createHash('md5').update(req.url).digest('hex') + '"';

  // conditional revalidation support
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    return res.end();
  }

  if (req.url.includes('no-store')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (req.url.includes('short')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=1', etag });
    return res.end(body);
  }
  // default: no cache headers -> distribution defaultTtl applies, has etag
  res.writeHead(200, { 'content-type': 'text/plain', etag });
  res.end(req.method === 'HEAD' ? undefined : body);
});
server.listen(9000, () => console.log('fake origin (MinIO stand-in) on http://localhost:9000  origin-hits countable'));
process.on('SIGTERM', () => { console.log('origin total hits:', hits); process.exit(0); });
