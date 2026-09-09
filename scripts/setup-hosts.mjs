#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const markerStart = '# LocalFront host aliases - managed block';
const markerEnd = '# End LocalFront host aliases';
const defaultMappings = [
  { hostname: 'site.local', port: 8080 },
  { hostname: 'api.local', port: 3001 },
  { hostname: 'app.local', port: 3000 },
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
  const argumentList = [scriptPath, ...args, '--elevated'].map(psQuote).join(',');
  const command = `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList @(${argumentList}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
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
  const block = new RegExp(`\\r?\\n?${markerStart}[\\s\\S]*?${markerEnd}\\r?\\n?`, 'g');
  return text.replace(block, '\n').replace(/\n{3,}/g, '\n\n');
}

try {
  if (!existsSync(hostsPath)) throw new Error(`hosts file not found at ${hostsPath}`);
  const mappings = [...defaultMappings, ...customMappings()];
  const hostnames = [...new Set(mappings.map(({ hostname }) => hostname))];
  const withoutBlock = removeManagedBlock(readFileSync(hostsPath, 'utf8'));
  const next = remove
    ? withoutBlock
    : `${withoutBlock.trimEnd()}\n\n${markerStart}\n127.0.0.1 ${hostnames.join(' ')}\n${markerEnd}\n`;

  writeFileSync(hostsPath, next, 'utf8');
  console.log(remove ? `Removed LocalFront aliases from ${hostsPath}` : `Added LocalFront aliases to ${hostsPath}`);
  if (!remove) {
    console.log('Use these URLs:');
    for (const { hostname, port } of mappings) console.log(`  http://${hostname}:${port}`);
  }
  if (process.platform === 'win32' && !process.env.LOCALFRONT_SKIP_DNS_FLUSH) {
    const dns = spawnSync('ipconfig', ['/flushdns'], { stdio: 'inherit' });
    if (dns.status !== 0) console.warn('Could not flush the DNS cache automatically. Run `ipconfig /flushdns` manually.');
  }
} catch (error) {
  if (process.platform === 'win32' && error.code === 'EPERM' && !elevated && !process.env.LOCALFRONT_HOSTS_PATH) {
    console.log('Windows requires Administrator access to update the hosts file. Opening an elevated setup prompt...');
    process.exit(rerunAsAdministrator());
  }
  console.error(`Could not update ${hostsPath}: ${error.message}`);
  console.error('On Windows, approve the Administrator prompt or run this command from an Administrator terminal.');
  process.exit(1);
}
