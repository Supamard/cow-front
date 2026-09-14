import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
  const hostsPath = path.join(tempDir, 'hosts');
  const caddyfilePath = path.join(tempDir, 'Caddyfile');
  await writeFile(hostsPath, '127.0.0.1 localhost\n\n# LocalFront host aliases - managed block\n127.0.0.1 legacy.local\n# End LocalFront host aliases\n', 'utf8');
  await writeFile(caddyfilePath, '# CowFront distribution routes - managed block\n# End CowFront distribution routes\n', 'utf8');
  const adminPort = await freePort();
  const proxyPort = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'localfront.mjs'), 'serve'], {
    cwd: tempDir,
    env: {
      ...process.env,
      LOCALFRONT_CONFIG: configPath,
      LOCALFRONT_ADMIN_PORT: String(adminPort),
      LOCALFRONT_PORT: String(proxyPort),
      LOCALFRONT_HOSTS_PATH: hostsPath,
      LOCALFRONT_CADDYFILE: caddyfilePath,
      LOCALFRONT_SKIP_DNS_FLUSH: '1',
      LOCALFRONT_SKIP_CADDY_RELOAD: '1',
    },
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
  assert.match(pageText, /<title>CowFront-Farm<\/title>/);
  assert.match(pageText, /src="\/cowfront-logo\.png"/);
  assert.match(pageText, /href="\/favicon\.ico"/);
  assert.match(pageText, /href="\/style\.css"/);
  assert.match(pageText, /Revalidation history/);
  assert.match(pageText, /Map hostname/);
  assert.match(pageText, /id="functionForm"/);
  assert.match(pageText, /Upload JavaScript/);
  assert.match(pageText, /Load remove \.html example/);
  assert.match(pageText, /Run through local CDN/);
  assert.match(pageText, /id="siteSwitcher"/);
  assert.match(pageText, /id="siteSearch"/);
  const dashboardScript = pageText.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(dashboardScript, 'dashboard script should be present');
  assert.doesNotThrow(() => new vm.Script(dashboardScript));
  assert.match(pageText, /http:\/\/cowfront\.local:/);
  const css = await fetch(`http://127.0.0.1:${adminPort}/style.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /\.workspace-grid/);
  assert.equal((await fetch('http://127.0.0.1:' + adminPort + '/favicon.ico')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:' + adminPort + '/cowfront-logo.png')).status, 200);
  const revalidations = await fetch(`http://127.0.0.1:${adminPort}/revalidations`);
  assert.deepEqual((await revalidations.json()).revalidations, []);
  const created = await fetch(`http://127.0.0.1:${adminPort}/distributions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domainName: 'shop.local', origin: { domainName: 'http://127.0.0.1:9' } }),
  });
  const distribution = await created.json();
  const pastedCode = 'function handler(event) { return event.request; }\n';
  const savedFunction = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}/functions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'viewerRequest', name: 'pasted-test.js', code: pastedCode }),
  });
  assert.equal(savedFunction.status, 201);
  const savedFunctionData = await savedFunction.json();
  assert.equal(savedFunctionData.eventType, 'viewerRequest');
  assert.equal(
    await readFile(path.join(tempDir, savedFunctionData.functionPath.replace(/^\.\//, '')), 'utf8'),
    pastedCode
  );
  const moveToResponseCode = 'function handler(event) { return event.response; }\n';
  const movedFunction = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}/functions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'viewerResponse', name: 'pasted-test.js', code: moveToResponseCode }),
  });
  assert.equal(movedFunction.status, 201);
  const afterMove = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}`);
  const movedDistribution = await afterMove.json();
  assert.equal(movedDistribution.defaultCacheBehavior.functionAssociations.viewerRequest, '');
  assert.match(movedDistribution.defaultCacheBehavior.functionAssociations.viewerResponse, /pasted-test\.js$/);
  const wrongEventCode = await readFile(
    path.join(root, 'examples', 'cloudfront-functions', 'remove-html-extension.js'),
    'utf8'
  );
  const rejectedWrongEvent = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}/functions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'viewerResponse', name: 'wrong-event.js', code: wrongEventCode }),
  });
  assert.equal(rejectedWrongEvent.status, 400);
  assert.match((await rejectedWrongEvent.json()).error, /associate it as a viewer-request function/);
  const cliUpdate = spawnSync(process.execPath, [
    path.join(root, 'localfront.mjs'),
    'update-distribution',
    distribution.id,
    '--viewer-request-function',
    './viewer-request.js',
  ], {
    cwd: tempDir,
    env: {
      ...process.env,
      LOCALFRONT_CONFIG: configPath,
      LOCALFRONT_ADMIN_PORT: String(adminPort),
      LOCALFRONT_PORT: String(proxyPort),
    },
    encoding: 'utf8',
  });
  assert.equal(cliUpdate.status, 0, cliUpdate.stderr);
  const afterFunctionUpdate = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}`);
  const updatedDistribution = await afterFunctionUpdate.json();
  assert.equal(updatedDistribution.origin.domainName, 'http://127.0.0.1:9');
  assert.equal(updatedDistribution.defaultCacheBehavior.functionAssociations.viewerRequest, './viewer-request.js');
  assert.match(await readFile(caddyfilePath, 'utf8'), /http:\/\/shop\.local[\s\S]*127\.0\.0\.1:/);
  assert.match(await readFile(caddyfilePath, 'utf8'), /shop\.local[\s\S]*@remote not remote_ip 127\.0\.0\.1 ::1/);
  const beforeMapping = await fetch(`http://127.0.0.1:${adminPort}/host-mappings`);
  assert.equal((await beforeMapping.json()).mappings['shop.local'].mapped, false);
  const mapped = await fetch(`http://127.0.0.1:${adminPort}/host-mappings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'shop.local' }),
  });
  assert.equal(mapped.status, 201);
  assert.match(await readFile(hostsPath, 'utf8'), /127\.0\.0\.1 .*shop\.local/);
  const secondCreated = await fetch(`http://127.0.0.1:${adminPort}/distributions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domainName: 'catalog.local', origin: { domainName: 'http://127.0.0.1:9' } }),
  });
  assert.equal(secondCreated.status, 201);
  const secondMapping = await fetch(`http://127.0.0.1:${adminPort}/host-mappings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: 'catalog.local' }),
  });
  assert.equal(secondMapping.status, 201);
  const hostsText = await readFile(hostsPath, 'utf8');
  assert.match(hostsText, /cowfront\.local/);
  assert.match(hostsText, /legacy\.local/);
  assert.doesNotMatch(hostsText, /# LocalFront host aliases/);
  assert.match(hostsText, /shop\.local/);
  assert.match(hostsText, /catalog\.local/);
  const afterMapping = await fetch(`http://127.0.0.1:${adminPort}/host-mappings`);
  assert.equal((await afterMapping.json()).mappings['shop.local'].mapped, true);
  const invalidated = await fetch(`http://127.0.0.1:${adminPort}/distributions/${distribution.id}/invalidations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: ['/index.html'] }),
  });
  assert.equal(invalidated.status, 201);
  const history = await fetch(`http://127.0.0.1:${adminPort}/revalidations`);
  assert.equal((await history.json()).revalidations[0].result, 'invalidated');
});

test('runs AWS-style CloudFront viewer request and response functions', async (t) => {
  const tempDir = await mkdtemp(path.join(root, '.tmp-functions-'));
  const originPort = await freePort();
  const adminPort = await freePort();
  const proxyPort = await freePort();
  const configPath = path.join(tempDir, 'distributions.json');
  const requestFunction = path.join(tempDir, 'viewer-request.js');
  const responseFunction = path.join(tempDir, 'viewer-response.js');

  await writeFile(requestFunction, `
function handler(event) {
  var crypto = require('crypto');
  var request = event.request;
  if (request.uri === '/blocked') {
    return {
      statusCode: 403,
      headers: { 'content-type': { value: 'text/plain' } },
      cookies: { reason: { value: 'edge', attributes: 'Path=/' } },
      body: 'blocked locally'
    };
  }
  if (request.uri === '/original') {
    request.uri = '/rewritten';
    request.querystring = { from: { value: 'function' } };
    request.headers['x-from-function'] = { value: 'yes' };
    request.headers['x-local-hash'] = { value: crypto.createHash('sha256').update('local').digest('hex') };
  }
  return request;
}
`, 'utf8');
  await writeFile(responseFunction, `
async function handler(event) {
  var response = event.response;
  response.headers['x-viewer-response'] = { value: event.context.eventType };
  response.headers['x-request-uri'] = { value: event.request.uri };
  if (event.request.uri === '/replace-body') {
    response.body = { encoding: 'text', data: 'replaced at the edge' };
    response.headers['content-type'] = { value: 'text/plain' };
  }
  return response;
}
`, 'utf8');
  await writeFile(configPath, JSON.stringify({
    distributions: [{
      id: 'ETESTFUNCTION1',
      domainName: 'functions.localhost',
      origin: { domainName: `http://127.0.0.1:${originPort}` },
      defaultCacheBehavior: {
        defaultTtl: 60,
        forwardQueryString: true,
        functionAssociations: {
          viewerRequest: './viewer-request.js',
          viewerResponse: './viewer-response.js',
        },
      },
    }],
  }, null, 2), 'utf8');

  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=60' });
    res.end(`${req.url}|${req.headers['x-from-function'] || ''}`);
  });
  await new Promise((resolve) => origin.listen(originPort, '127.0.0.1', resolve));
  const server = spawn(process.execPath, [path.join(root, 'localfront.mjs'), 'serve'], {
    cwd: tempDir,
    env: {
      ...process.env,
      LOCALFRONT_CONFIG: configPath,
      LOCALFRONT_ADMIN_PORT: String(adminPort),
      LOCALFRONT_PORT: String(proxyPort),
      LOCALFRONT_CADDYFILE: path.join(tempDir, 'missing-Caddyfile'),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    origin.close();
    if (server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitFor(`http://127.0.0.1:${adminPort}/health`, server);
  const headers = { 'x-distribution-id': 'ETESTFUNCTION1' };
  const rewritten = await fetch(`http://127.0.0.1:${proxyPort}/original?ignored=true`, { headers });
  assert.equal(rewritten.status, 200);
  assert.equal(await rewritten.text(), '/rewritten?from=function|yes');
  assert.equal(rewritten.headers.get('x-viewer-response'), 'viewer-response');
  assert.equal(rewritten.headers.get('x-request-uri'), '/rewritten');

  const hit = await fetch(`http://127.0.0.1:${proxyPort}/original?ignored=true`, { headers });
  assert.match(hit.headers.get('x-cache'), /^Hit/);
  assert.equal(hit.headers.get('x-viewer-response'), 'viewer-response');

  const replaced = await fetch(`http://127.0.0.1:${proxyPort}/replace-body`, { headers });
  assert.equal(await replaced.text(), 'replaced at the edge');

  const blocked = await fetch(`http://127.0.0.1:${proxyPort}/blocked`, { headers });
  assert.equal(blocked.status, 403);
  assert.equal(await blocked.text(), 'blocked locally');
  assert.match(blocked.headers.get('set-cookie'), /^reason=edge/);
  assert.equal(blocked.headers.get('x-viewer-response'), null);
  assert.match(blocked.headers.get('x-cache'), /^FunctionGenerated/);

  // Run the shipped copy/paste example itself, proving edits are picked up without restart.
  const removeHtmlExample = await readFile(
    path.join(root, 'examples', 'cloudfront-functions', 'remove-html-extension.js'),
    'utf8'
  );
  await writeFile(requestFunction, removeHtmlExample, 'utf8');
  const cleanUrl = await fetch(
    `http://127.0.0.1:${proxyPort}/guide.html?tag=one&tag=two&lang=en`,
    { headers, redirect: 'manual' }
  );
  assert.equal(cleanUrl.status, 301);
  assert.equal(cleanUrl.headers.get('location'), '/guide?tag=one&tag=two&lang=en');
  assert.equal(cleanUrl.headers.get('x-viewer-response'), null);

  const cleanObject = await fetch(`http://127.0.0.1:${proxyPort}/guide`, { headers });
  assert.match(await cleanObject.text(), /^\/guide\.html\|/);

  const dashboardTest = await fetch(`http://127.0.0.1:${adminPort}/distributions/ETESTFUNCTION1/function-test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/dashboard.html?lang=en' }),
  });
  const dashboardTestData = await dashboardTest.json();
  assert.equal(dashboardTestData.status, 301);
  assert.equal(dashboardTestData.headers.location, '/dashboard?lang=en');
});
