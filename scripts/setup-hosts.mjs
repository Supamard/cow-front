#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const markerStart = '# CowFront host aliases - managed block';
const markerEnd = '# End CowFront host aliases';
const legacyMarkerStart = '# LocalFront host aliases - managed block';
const legacyMarkerEnd = '# End LocalFront host aliases';
const defaultMappings = [
  // Caddy fronts these on port 80, so they have no port in their URL.
  { hostname: 'cowfront.local', port: 80 },
  { hostname: 'gh-dev.test', port: 80 },
  { hostname: 'app.local', port: 80 },
  { hostname: 'site.local', port: 8080 },
  { hostname: 'api.local', port: 3001 },
];
const defaultHostsPath = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';
const hostsPath = process.env.LOCALFRONT_HOSTS_PATH || defaultHostsPath;
const remove = process.argv.includes('--remove');
const elevated = process.argv.includes('--elevated');

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rerunAsAdministrator() {
  const scriptPath = fileURLToPath(import.meta.url);
  const args = process.argv.slice(2).filter((arg) => arg !== '--elevated');
  const argumentList = [scriptPath, ...args, '--elevated']
    .map((value) => `"${String(value).replaceAll('"', '\\"')}"`)
    .join(' ');
  const command = `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote(argumentList)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
  return result.status ?? 1;
}

function customMappings() {
  const mappings = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] !== '--map') continue;
    const value = process.argv[++i];
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)[:=](\d{1,5})$/i.exec(value || '');
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
      throw new Error(`invalid mapping "${value || ''}"; use --map name.local=port`);
    }
    mappings.push({ hostname: match[1].toLowerCase(), port: Number(match[2]) });
  }
  return mappings;
}

function removeManagedBlock(text) {
  let result = text;
  for (const [start, end] of [[markerStart, markerEnd], [legacyMarkerStart, legacyMarkerEnd]]) {
    const block = new RegExp(`\\r?\\n?${start}[\\s\\S]*?${end}\\r?\\n?`, 'g');
    result = result.replace(block, '\n');
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

function managedHostnames(text) {
  const hostnames = [];
  for (const [startMarker, endMarker] of [[markerStart, markerEnd], [legacyMarkerStart, legacyMarkerEnd]]) {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    if (start === -1 || end === -1) continue;
    const block = text.slice(start + startMarker.length, end);
    for (const line of block.split(/\r?\n/)) {
      const active = line.split('#')[0].trim();
      if (!active) continue;
      const [, ...aliases] = active.split(/\s+/);
      hostnames.push(...aliases.map((hostname) => hostname.toLowerCase()));
    }
  }
  return hostnames;
}

function distributionMappings() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const configPath = process.env.LOCALFRONT_CONFIG || path.resolve(process.cwd(), 'distributions.json');
  const targetPath = existsSync(configPath) ? configPath : path.resolve(root, 'distributions.json');
  if (!existsSync(targetPath)) return [];
  try {
    const raw = readFileSync(targetPath, 'utf8');
    const config = JSON.parse(raw);
    const dists = Array.isArray(config.distributions) ? config.distributions : [];
    const results = [];
    for (const d of dists) {
      const hostname = String(d.domainName || '').trim().toLowerCase();
      if (hostname && !hostname.endsWith('.localhost') && hostname !== 'localhost') {
        results.push({ hostname, port: null });
      }
    }
    return results;
  } catch {
    return [];
  }
}

try {
  if (!existsSync(hostsPath)) throw new Error(`hosts file not found at ${hostsPath}`);
  const current = readFileSync(hostsPath, 'utf8');
  const existingMappings = managedHostnames(current).map((hostname) => ({ hostname, port: null }));
  const mappings = [...defaultMappings, ...distributionMappings(), ...existingMappings, ...customMappings()];
  const hostnames = [...new Set(mappings.map(({ hostname }) => hostname))];
  const withoutBlock = removeManagedBlock(current);
  const next = remove
    ? withoutBlock
    : `${withoutBlock.trimEnd()}\n\n${markerStart}\n127.0.0.1 ${hostnames.join(' ')}\n${markerEnd}\n`;

  writeFileSync(hostsPath, next, 'utf8');
  console.log(remove ? `Removed CowFront aliases from ${hostsPath}` : `Added CowFront aliases to ${hostsPath}`);
  if (!remove) {
    console.log('Use these URLs:');
    for (const { hostname, port } of mappings) {
      // Port 80 is Caddy's, and a default port does not belong in the URL.
      if (port) console.log(`  http://${hostname}${port === 80 ? '' : `:${port}`}`);
    }
  }
  if (process.platform === 'win32' && !process.env.LOCALFRONT_SKIP_DNS_FLUSH) {
    const dns = spawnSync('ipconfig', ['/flushdns'], { stdio: 'inherit' });
    if (dns.status !== 0) console.warn('Could not flush the DNS cache automatically. Run `ipconfig /flushdns` manually.');
  }
} catch (error) {
  if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code) && !elevated && !process.env.LOCALFRONT_HOSTS_PATH) {
    console.log('Windows requires Administrator access to update the hosts file. Opening an elevated setup prompt...');
    process.exit(rerunAsAdministrator());
  }
  console.error(`Could not update ${hostsPath}: ${error.message}`);
  console.error('On Windows, approve the Administrator prompt or run this command from an Administrator terminal.');
  process.exit(1);
}
