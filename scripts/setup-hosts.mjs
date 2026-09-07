#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
} catch (error) {
  console.error(`Could not update ${hostsPath}: ${error.message}`);
  console.error('On Windows, rerun this command from an Administrator terminal.');
  process.exit(1);
}
