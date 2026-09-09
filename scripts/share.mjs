#!/usr/bin/env node

// Prints the exact instructions to send teammates so `http://gh-dev.test`
// resolves on their machines. Re-run it whenever this machine's address
// changes: hosts-file entries are pinned to an IP and break silently when
// DHCP moves it.

import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

const sharedHostname = 'gh-dev.test';
const httpPort = Number(process.env.LOCALFRONT_CADDY_PORT) || 80;
const upstream = { host: '127.0.0.1', port: 3015 };

// Selecting a route does not put a packet on the wire; this only asks the OS
// which local address it would use to reach the internet, which is the one
// teammates can reach. Falls back to interface inspection if that is blocked.
function lanAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const fallback = () => {
      socket.close();
      const skip = /loopback|vethernet|virtual|wsl|hyper-v|bluetooth|vmware|docker/i;
      for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        if (skip.test(name)) continue;
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
            return resolve(address.address);
          }
        }
      }
      resolve('');
    };
    socket.once('error', fallback);
    try {
      socket.connect(53, '203.0.113.1', () => {
        const address = socket.address().address;
        socket.close();
        resolve(address && address !== '0.0.0.0' ? address : '');
      });
    } catch {
      fallback();
    }
  });
}

function reachable({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function addressIsDynamic() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq "Dhcp" } | Select-Object -ExpandProperty IPAddress',
  ], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean).map((value) => value.trim()) : null;
}

const address = await lanAddress();
if (!address) {
  console.error('Could not determine this machine\'s LAN address. Check that you are on a network.');
  process.exit(1);
}

const suffix = httpPort === 80 ? '' : `:${httpPort}`;
const hostsLine = `${address} ${sharedHostname}`;
const dynamic = addressIsDynamic();

console.log(`Machine:     ${os.hostname()}`);
console.log(`LAN address: ${address}`);
console.log(`Serving:     http://${sharedHostname}${suffix} -> ${upstream.host}:${upstream.port}`);
console.log('');

const caddyUp = await reachable({ host: '127.0.0.1', port: httpPort });
const appUp = await reachable(upstream);
console.log(`Caddy on port ${httpPort}: ${caddyUp ? 'running' : 'NOT RUNNING - run npm run caddy:activate'}`);
console.log(`App on port ${upstream.port}:   ${appUp ? 'running' : 'NOT RUNNING - start the project first'}`);
console.log('');

console.log('--- Send everything below to your teammates ---');
console.log('');
console.log(`To use http://${sharedHostname}${suffix}, add one line to your hosts file.`);
console.log('');
console.log('Windows - PowerShell as Administrator:');
console.log(`  Add-Content -Path "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Value "${hostsLine}"`);
console.log('  ipconfig /flushdns');
console.log('');
console.log('macOS / Linux:');
console.log(`  echo "${hostsLine}" | sudo tee -a /etc/hosts`);
console.log('  # macOS only, to flush the cache:');
console.log('  sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
console.log('');
console.log(`Then open http://${sharedHostname}${suffix}`);
console.log('');
console.log(`No setup needed if you would rather not edit hosts: http://${address}${suffix}`);
console.log('');
console.log('--- End ---');

if (dynamic && dynamic.includes(address)) {
  console.log('');
  console.log(`Note: ${address} is a DHCP address and can change. If it does, teammates get`);
  console.log('DNS_PROBE_FINISHED_NXDOMAIN again. Re-run `npm run share` and send the new line,');
  console.log('or ask whoever runs the network for a DHCP reservation so it stops moving.');
}
