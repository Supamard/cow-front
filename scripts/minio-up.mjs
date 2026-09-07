#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ports = [
  { name: 'MinIO API', port: 9000 },
  { name: 'MinIO console', port: 9001 },
];

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function main() {
  const occupied = [];
  for (const entry of ports) {
    if (await isPortOpen(entry.port)) occupied.push(entry);
  }

  if (occupied.length) {
    const list = occupied.map((entry) => `${entry.name} (${entry.port})`).join(', ');
    console.log(`MinIO already appears to be running on ${list}; skipping docker compose up.`);
    process.exit(0);
  }

  const autoStart = process.argv.includes('--yes') || process.env.MINIO_AUTO_START === '1';
  if (!autoStart) {
    if (!input.isTTY || !output.isTTY) {
      console.log('MinIO was not found on ports 9000 or 9001; skipping docker compose up in non-interactive mode.');
      console.log('Run `npm run minio:up -- --yes` to start it automatically.');
      process.exit(0);
    }

    const prompt = readline.createInterface({ input, output });
    const answer = await prompt.question('MinIO was not found. Start it with Docker Compose? [y/N] ');
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Skipped starting MinIO.');
      process.exit(0);
    }
  }

  const result = spawnSync('docker', ['compose', 'up', '-d'], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Failed to start MinIO: ${result.error.message}`);
    process.exit(result.status ?? 1);
  }
  process.exit(result.status ?? 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
