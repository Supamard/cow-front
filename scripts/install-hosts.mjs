#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : '';
const isGlobalInstall = process.env.npm_config_global === 'true';
const isProjectInstall = installRoot === appRoot;

// Avoid changing the machine when CowFront is merely a transitive dependency.
if (!isGlobalInstall && !isProjectInstall) process.exit(0);

console.log('Setting up http://cowfront.local:5744 ...');
const result = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'setup-hosts.mjs')], {
  cwd: appRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.warn('CowFront installed, but the local hostname could not be configured automatically.');
  console.warn('Run `npm run hosts:setup` from an elevated terminal to retry.');
}

// Host-file permissions should not leave the package itself half-installed.
process.exit(0);
