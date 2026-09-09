#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const bucket = option('--bucket', process.env.MINIO_BUCKET);
const prefix = option('--prefix', process.env.MINIO_PREFIX || '');

if (!bucket || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(bucket)) {
  console.error('A valid bucket is required. Use --bucket <bucket> or MINIO_BUCKET.');
  process.exit(1);
}

if (prefix && !/^[^\s*?]+(?:\/[^\s*?]+)*$/.test(prefix)) {
  console.error('Invalid prefix. Use --prefix data/site.local without wildcards.');
  process.exit(1);
}

const target = prefix ? `local/${bucket}/${prefix}` : `local/${bucket}`;
const command = `until mc alias set local http://minio:9000 minioadmin minioadmin; do echo 'waiting for minio...'; sleep 1; done; mc anonymous set download ${target}`;
const result = spawnSync('docker', [
  'compose', 'run', '--rm', '--entrypoint', 'sh', 'createbuckets', '-c', command,
], { stdio: 'inherit' });

if (result.error) {
  console.error(`Failed to configure MinIO: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
