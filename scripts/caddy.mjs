#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(appRoot, 'Caddyfile');
const dataPath = path.join(appRoot, '.caddy', 'data');
const configHome = path.join(appRoot, '.caddy', 'config');
const command = process.argv[2] || 'check';
const elevated = process.argv.includes('--elevated');

// Caddy owns port 80 so local hostnames need no port suffix. The Caddyfile
// reads the same variable, so the script and the config cannot disagree.
const defaultHttpPort = 80;
const fallbackHost = '127.0.0.1';
const fallbackPort = '3015';

function resolveHttpPort() {
  const raw = process.env.LOCALFRONT_CADDY_PORT;
  if (!raw) return defaultHttpPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid LOCALFRONT_CADDY_PORT "${raw}": use a port between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

const httpPort = resolveHttpPort();

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function findCaddy() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['caddy'], { encoding: 'utf8' });
  const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean)?.trim() : '';
  if (found) return found;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return '';
  const packagesRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  if (!existsSync(packagesRoot)) return '';
  const packageDirectory = readdirSync(packagesRoot).find((name) => name.startsWith('CaddyServer.Caddy_'));
  if (!packageDirectory) return '';
  const wingetCaddy = path.join(packagesRoot, packageDirectory, 'caddy.exe');
  return existsSync(wingetCaddy) ? wingetCaddy : '';
}

function caddyEnvironment() {
  return {
    ...process.env,
    XDG_DATA_HOME: dataPath,
    XDG_CONFIG_HOME: configHome,
    LOCALFRONT_CADDY_PORT: String(httpPort),
  };
}

function caddy(commandArgs, options = {}) {
  const executable = findCaddy();
  if (!executable) {
    console.error('Caddy is not installed or is not in PATH.');
    console.error(process.platform === 'win32'
      ? 'Install it with `choco install caddy` or `scoop install caddy`.'
      : 'See https://caddyserver.com/docs/install');
    process.exitCode = 1;
    return null;
  }
  mkdirSync(dataPath, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  return spawnSync(executable, commandArgs, {
    cwd: appRoot,
    env: caddyEnvironment(),
    stdio: options.capture ? 'pipe' : options.silent ? 'ignore' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  });
}

// Caddy serves the LAN from this port, so probe the wildcard address it binds.
function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(null)));
  });
}

async function waitForCaddy() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:2019/config/', {
        headers: { origin: 'http://localhost:2019' },
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function portOwners(port) {
  if (process.platform !== 'win32') return '';
  const psCommand = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue`
    + ' | Select-Object -ExpandProperty OwningProcess -Unique'
    + ' | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean).join(', ') : '';
}

// The Windows portproxy feature (service: iphlpsvc) holds the port through
// svchost, which is why a plain process listing never names the real owner.
function portproxyRule() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('netsh.exe', ['interface', 'portproxy', 'show', 'all'], { encoding: 'utf8' });
  const pattern = new RegExp(`^\\s*(\\S+)\\s+${httpPort}\\s+(\\S+)\\s+(\\d+)\\s*$`, 'm');
  const match = result.stdout.match(pattern);
  return match ? { listenAddress: match[1], connectAddress: match[2], connectPort: match[3] } : null;
}

function setPortproxy(action, rule) {
  const args = ['interface', 'portproxy', action, 'v4tov4', `listenaddress=${rule.listenAddress}`, `listenport=${httpPort}`];
  if (action === 'add') args.push(`connectaddress=${rule.connectAddress}`, `connectport=${rule.connectPort}`);
  return spawnSync('netsh.exe', args, { encoding: 'utf8' });
}

async function check() {
  if (!existsSync(configPath)) throw new Error(`Caddyfile not found at ${configPath}`);
  const executable = findCaddy();
  if (!executable) {
    console.log('Caddy: not installed');
  } else {
    const version = spawnSync(executable, ['version'], { encoding: 'utf8' });
    console.log(`Caddy: ${(version.stdout || version.stderr).trim()} (${executable})`);
    const validation = caddy(['validate', '--config', configPath]);
    if (validation?.status !== 0) process.exitCode = validation?.status || 1;
  }

  const conflict = await checkPort(httpPort);
  if (!conflict) {
    console.log(`Port ${httpPort}: available`);
    return;
  }
  const owners = portOwners(httpPort);
  console.log(`Port ${httpPort}: unavailable (${conflict.code})${owners ? ` - used by ${owners}` : ''}`);
  const rule = portproxyRule();
  if (rule) {
    console.log(`Windows portproxy: ${rule.listenAddress}:${httpPort} -> ${rule.connectAddress}:${rule.connectPort}`);
    console.log('Run npm run caddy:activate to hand this forwarding to Caddy.');
  }
  process.exitCode = 2;
}

function rerunActivationAsAdministrator() {
  const scriptPath = fileURLToPath(import.meta.url);
  mkdirSync(path.join(appRoot, '.caddy'), { recursive: true });
  const argumentList = [scriptPath, 'prepare', '--elevated']
    .map((value) => `"${String(value).replaceAll('"', '\\"')}"`)
    .join(' ');
  const psCommand = `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argumentList)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
}

async function activate() {
  if (process.platform !== 'win32') {
    console.error('Automatic portproxy migration is available only on Windows.');
    process.exitCode = 1;
    return;
  }
  if (!elevated) {
    const result = rerunActivationAsAdministrator();
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      return;
    }
    return startDetachedCaddy();
  }

  const executable = findCaddy();
  if (!executable) {
    console.error('Caddy is not installed. Run npm run caddy:install first.');
    process.exitCode = 1;
    return;
  }
  const validation = caddy(['validate', '--config', configPath]);
  if (!validation || validation.status !== 0) {
    process.exitCode = validation?.status || 1;
    return;
  }

  // Only the known forwarding is replaced; an unrecognised owner is left alone.
  const rule = portproxyRule();
  if (rule && (rule.connectAddress !== fallbackHost || rule.connectPort !== fallbackPort)) {
    console.error(`Refusing to change port ${httpPort}: expected a portproxy rule to ${fallbackHost}:${fallbackPort}, found ${rule.connectAddress}:${rule.connectPort}.`);
    process.exitCode = 2;
    return;
  }
  if (!rule) {
    const conflict = await checkPort(httpPort);
    if (conflict) {
      console.error(`Refusing to start Caddy because port ${httpPort} is occupied by an unknown listener (${conflict.code}).`);
      process.exitCode = 2;
      return;
    }
  }

  const hosts = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'setup-hosts.mjs'), '--elevated'], {
    cwd: appRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (hosts.status !== 0) {
    process.exitCode = hosts.status || 1;
    return;
  }

  if (rule) {
    const removed = setPortproxy('delete', rule);
    if (removed.status !== 0) {
      console.error((removed.stderr || removed.stdout || 'Could not remove the existing portproxy rule').trim());
      process.exitCode = removed.status || 1;
      return;
    }
  }

  // Preparation runs elevated and exits before Caddy is launched. Starting it
  // from the original process avoids tying Caddy's lifetime to the UAC helper.
}

function restorePortproxyAsAdministrator() {
  const netshArgs = 'interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=127.0.0.1 connectport=3015';
  const psArgs = `-NoProfile -Command "netsh ${netshArgs}"`;
  const psCommand = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList ${psQuote(psArgs)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
}

async function startDetachedCaddy() {
  const executable = findCaddy();
  mkdirSync(dataPath, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  let started;
  try {
    const elevatedCommand = [
      `$env:XDG_DATA_HOME = ${psQuote(dataPath)}`,
      `$env:XDG_CONFIG_HOME = ${psQuote(configHome)}`,
      `$env:LOCALFRONT_CADDY_PORT = ${psQuote(String(httpPort))}`,
      `Set-Location -LiteralPath ${psQuote(appRoot)}`,
      `& ${psQuote(executable)} run --config Caddyfile *> ${psQuote(path.join(appRoot, '.caddy', 'caddy.log'))}`,
    ].join('; ');
    const encoded = Buffer.from(elevatedCommand, 'utf16le').toString('base64');
    const psCommand = `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-EncodedCommand','${encoded}' -Verb RunAs -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`;
    started = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8' });
  } catch (error) {
    restorePortproxyAsAdministrator();
    process.exitCode = 1;
    return;
  }
  if (started.status !== 0) {
    restorePortproxyAsAdministrator();
    process.exitCode = started.status || 1;
    return;
  }
  const startedPid = Number(String(started.stdout || '').trim());
  if (!startedPid) console.warn('Windows did not return a Caddy process ID after the elevation request.');
  const startFailure = !(await waitForCaddy());
  if (startFailure) {
    console.error('Caddy did not start. See .caddy/caddy.log for details.');
    if (started.stderr?.trim()) console.error(started.stderr.trim());
    caddy(['stop'], { silent: true });
    console.error('Restoring the original Windows portproxy rule.');
    const restored = restorePortproxyAsAdministrator();
    if (restored.status !== 0) {
      console.error(`Automatic rollback failed. Restore 0.0.0.0:${httpPort} -> ${fallbackHost}:${fallbackPort} manually.`);
    }
    process.exitCode = 1;
    return;
  }
  const suffix = httpPort === 80 ? '' : `:${httpPort}`;
  console.log(`Caddy is running on port ${httpPort}:`);
  console.log(`  http://cowfront.local${suffix} -> 127.0.0.1:5744 (this machine only)`);
  console.log(`  http://app.local${suffix}      -> ${fallbackHost}:${fallbackPort} (reachable on the LAN)`);
}

if (command === 'install') {
  if (findCaddy()) {
    console.log(`Caddy is already installed at ${findCaddy()}`);
  } else if (process.platform === 'win32') {
    const result = spawnSync('winget.exe', [
      'install', '--id', 'CaddyServer.Caddy', '--exact', '--scope', 'user',
      '--accept-package-agreements', '--accept-source-agreements', '--silent',
    ], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status || 1;
  } else {
    console.error('Automatic Caddy installation is currently supported only on Windows.');
    console.error('See https://caddyserver.com/docs/install');
    process.exitCode = 1;
  }
} else if (command === 'check') {
  await check();
} else if (command === 'activate' || command === 'prepare') {
  await activate();
} else if (command === 'run') {
  const conflict = await checkPort(httpPort);
  if (conflict) {
    console.error(`Cannot start Caddy: port ${httpPort} is already in use (${conflict.code}). Run npm run caddy:check for details.`);
    process.exitCode = 2;
  } else {
    const result = caddy(['run', '--config', configPath]);
    if (result && result.status !== 0) process.exitCode = result.status || 1;
  }
} else if (command === 'reload') {
  const result = caddy(['reload', '--config', configPath]);
  if (result && result.status !== 0) process.exitCode = result.status || 1;
} else if (command === 'stop') {
  const result = caddy(['stop']);
  if (result && result.status !== 0) process.exitCode = result.status || 1;
} else {
  console.error(`Unknown command ${command}. Use install, check, activate, run, reload, or stop.`);
  process.exitCode = 1;
}
