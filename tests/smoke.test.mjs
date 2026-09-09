import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, process) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (process.exitCode !== null) throw new Error(`server exited with code ${process.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready at ${url}`);
}

test('CLI help is available', () => {
  const result = spawnSync(process.execPath, ['localfront.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /create-distribution/);
});

test('serve exposes the admin page and package stylesheet', async (t) => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-test-'));
  const configPath = path.join(tempDir, 'distributions.json');
  const adminPort = await freePort();
  const proxyPort = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'localfront.mjs'), 'serve'], {
    cwd: tempDir,
    env: { ...process.env, LOCALFRONT_CONFIG: configPath, LOCALFRONT_ADMIN_PORT: String(adminPort), LOCALFRONT_PORT: String(proxyPort) },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const health = await waitFor(`http://127.0.0.1:${adminPort}/health`, server);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(`http://127.0.0.1:${adminPort}/`);
  const pageText = await page.text();
  assert.match(pageText, /<title>CowFront Admin<\/title>/);
  assert.match(pageText, /src="\/cowfront-logo\.png"/);
  assert.match(pageText, /href="\/favicon\.ico"/);
  assert.match(pageText, /href="\/style\.css"/);
  assert.match(pageText, /Revalidation history/);
  const css = await fetch(`http://127.0.0.1:${adminPort}/style.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /\.top-grid/);
  assert.equal((await fetch('http://127.0.0.1:' + adminPort + '/favicon.ico')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:' + adminPort + '/cowfront-logo.png')).status, 200);
  const revalidations = await fetch(`http://127.0.0.1:${adminPort}/revalidations`);
  assert.deepEqual((await revalidations.json()).revalidations, []);
  const created = await fetch(`http://127.0.0.1:${adminPort}/distributions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: { domainName: 'http://127.0.0.1:9' } }),
  });
  const distribution = await created.json();
  const invalidated = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}/invalidations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['/index.html'] }),
  });
  assert.equal(invalidated.status, 201);
  const history = await fetch(`http://127.0.0.1:${adminPort}/revalidations`);
  assert.equal((await history.json()).revalidations[0].result, 'invalidated');
});
