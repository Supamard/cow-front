#!/usr/bin/env node

/**
 * CowFront Setup State Audit & Recommendations Engine
 * Audits Node.js, MinIO, Docker, Caddy, Hosts mappings, CowFront server ports,
 * distributions, and function associations based on README.md requirements.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');

const DEFAULT_HOSTS_PATH = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

const STANDARD_HOSTNAMES = [
  'cowfront.local',
  'gh-dev.test',
  'app.local',
  'site.local',
  'api.local',
];

// ----------------------------------------------------------------------------- Probe Helpers

export function isPortOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (val) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(val);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

export function findCaddyExecutable() {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['caddy'], { encoding: 'utf8' });
  const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean)?.trim() : '';
  if (found) return found;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return '';
  const packagesRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  if (!existsSync(packagesRoot)) return '';
  try {
    const packageDirectory = readdirSync(packagesRoot).find((name) => name.startsWith('CaddyServer.Caddy_'));
    if (!packageDirectory) return '';
    const wingetCaddy = path.join(packagesRoot, packageDirectory, 'caddy.exe');
    return existsSync(wingetCaddy) ? wingetCaddy : '';
  } catch {
    return '';
  }
}

export function portproxyRule(targetPort = 80) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('netsh.exe', ['interface', 'portproxy', 'show', 'all'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const pattern = new RegExp(`^\\s*(\\S+)\\s+${targetPort}\\s+(\\S+)\\s+(\\d+)\\s*$`, 'm');
  const match = result.stdout.match(pattern);
  return match ? { listenAddress: match[1], listenPort: targetPort, connectAddress: match[2], connectPort: match[3] } : null;
}

export function parseHostsFile(hostsPath) {
  if (!existsSync(hostsPath)) return { exists: false, hasManagedBlock: false, mapped: new Set() };
  try {
    const content = readFileSync(hostsPath, 'utf8');
    const hasManagedBlock = content.includes('# CowFront host aliases - managed block')
      || content.includes('# LocalFront host aliases - managed block');
    const mapped = new Set();
    for (const line of content.split(/\r?\n/)) {
      const active = line.split('#')[0].trim();
      if (!active) continue;
      const [address, ...aliases] = active.split(/\s+/);
      if (address === '127.0.0.1' || address === '::1') {
        for (const alias of aliases) mapped.add(alias.toLowerCase());
      }
    }
    return { exists: true, hasManagedBlock, mapped };
  } catch (err) {
    return { exists: true, hasManagedBlock: false, mapped: new Set(), error: err.message };
  }
}

// ----------------------------------------------------------------------------- Audit Engine

export async function runAudit(options = {}) {
  const root = options.appRoot || APP_ROOT;
  const configPath = options.configPath || process.env.LOCALFRONT_CONFIG || path.resolve(root, 'distributions.json');
  const hostsPath = options.hostsPath || process.env.LOCALFRONT_HOSTS_PATH || DEFAULT_HOSTS_PATH;
  const caddyfilePath = options.caddyfilePath || process.env.LOCALFRONT_CADDYFILE || path.join(root, 'Caddyfile');
  const caddyPort = Number(process.env.LOCALFRONT_CADDY_PORT) || 80;
  const proxyPort = Number(process.env.LOCALFRONT_PORT) || 8080;
  const adminPort = Number(process.env.LOCALFRONT_ADMIN_PORT) || 5744;

  const categories = [];
  const recommendations = [];

  function addRec(id, title, command, reason, docRef = '') {
    if (recommendations.some((r) => r.id === id)) return;
    recommendations.push({ id, title, command, reason, docRef });
  }

  // 1. Node.js Runtime
  const nodeChecks = [];
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 18) {
    nodeChecks.push({
      name: 'Node.js Version',
      status: 'pass',
      message: `Node.js ${process.version} (meets >= 18 requirement)`,
    });
  } else {
    nodeChecks.push({
      name: 'Node.js Version',
      status: 'fail',
      message: `Node.js ${process.version} is installed, but CowFront requires Node.js >= 18`,
    });
    addRec('node-upgrade', 'Upgrade Node.js', 'nvm install 20 (or download from https://nodejs.org/)',
      'Node.js 18+ is required for native fetch, crypto, and zlib features.', 'README.md: Requirements');
  }
  nodeChecks.push({
    name: 'Operating System',
    status: 'info',
    message: `${process.platform} (${process.arch})`,
  });
  categories.push({ id: 'runtime', name: 'Runtime Environment', checks: nodeChecks });

  // 2. Core Dependencies & Storage (MinIO, Docker, Caddy, mc)
  const depChecks = [];

  // Docker & Docker Compose
  let dockerAvailable = false;
  let dockerComposeAvailable = false;
  try {
    const dRes = spawnSync('docker', ['--version'], { encoding: 'utf8' });
    if (dRes.status === 0) {
      dockerAvailable = true;
      const cRes = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
      dockerComposeAvailable = cRes.status === 0;
    }
  } catch {}

  if (dockerAvailable && dockerComposeAvailable) {
    depChecks.push({
      name: 'Docker & Compose',
      status: 'pass',
      message: 'Docker and Docker Compose are installed and ready',
    });
  } else if (dockerAvailable) {
    depChecks.push({
      name: 'Docker & Compose',
      status: 'warn',
      message: 'Docker is installed, but "docker compose" plugin was not found',
    });
  } else {
    depChecks.push({
      name: 'Docker & Compose',
      status: 'warn',
      message: 'Docker is not installed or not in PATH',
    });
  }

  // MinIO Ports (9000 API, 9001 console)
  const minioApiUp = await isPortOpen(9000);
  const minioConsoleUp = await isPortOpen(9001);
  if (minioApiUp) {
    depChecks.push({
      name: 'MinIO S3 API (:9000)',
      status: 'pass',
      message: 'MinIO S3 API is active and listening on port 9000',
    });
  } else {
    depChecks.push({
      name: 'MinIO S3 API (:9000)',
      status: 'fail',
      message: 'MinIO S3 API is not running on port 9000',
    });
    if (dockerComposeAvailable || dockerAvailable) {
      addRec('minio-up', 'Start MinIO with Docker Compose', 'npm run minio:up -- --yes',
        'Starts MinIO and initializes the public assets bucket.', 'README.md: Quickstart step 1');
    } else {
      addRec('minio-install', 'Install Docker Desktop or standalone MinIO', 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/',
        'MinIO is the local S3-compatible origin for CowFront.', 'README.md: Requirements');
    }
  }

  if (minioConsoleUp) {
    depChecks.push({
      name: 'MinIO Console (:9001)',
      status: 'pass',
      message: 'MinIO Web Console is active on port 9001',
    });
  } else if (minioApiUp) {
    depChecks.push({
      name: 'MinIO Console (:9001)',
      status: 'info',
      message: 'MinIO Console not responding on port 9001 (API is active)',
    });
  }

  // MinIO Client (mc)
  let mcFound = false;
  try {
    const mcProbe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['mc'], { encoding: 'utf8' });
    mcFound = mcProbe.status === 0;
  } catch {}

  if (mcFound) {
    depChecks.push({
      name: 'MinIO Client (mc)',
      status: 'pass',
      message: 'MinIO Client (mc) CLI is installed in PATH',
    });
  } else {
    depChecks.push({
      name: 'MinIO Client (mc)',
      status: 'info',
      message: 'MinIO Client (mc) not found in PATH (Docker Compose helper container can be used instead)',
    });
  }

  // Caddy Web Server
  const caddyExec = findCaddyExecutable();
  if (caddyExec) {
    depChecks.push({
      name: 'Caddy Executable',
      status: 'pass',
      message: `Caddy is installed (${caddyExec})`,
    });

    if (existsSync(caddyfilePath)) {
      try {
        const valRes = spawnSync(caddyExec, ['validate', '--config', caddyfilePath], { encoding: 'utf8' });
        if (valRes.status === 0) {
          depChecks.push({
            name: 'Caddyfile Validation',
            status: 'pass',
            message: `Caddyfile syntax is valid (${path.relative(root, caddyfilePath)})`,
          });
        } else {
          depChecks.push({
            name: 'Caddyfile Validation',
            status: 'warn',
            message: `Caddyfile validation warning: ${(valRes.stderr || valRes.stdout || '').trim()}`,
          });
        }
      } catch {}
    }
  } else {
    depChecks.push({
      name: 'Caddy Executable',
      status: 'warn',
      message: 'Caddy is not installed or not in PATH',
    });
    if (process.platform === 'win32') {
      addRec('caddy-install', 'Install Caddy with WinGet', 'npm run caddy:install',
        'Caddy provides portless local hostnames like http://cowfront.local and http://site.local.', 'README.md: Portless local hostnames with Caddy');
    } else {
      addRec('caddy-install', 'Install Caddy', 'Follow instructions at https://caddyserver.com/docs/install',
        'Caddy fronts local HTTP traffic on port 80.', 'README.md: Portless local hostnames with Caddy');
    }
  }

  // Caddy Port Status & Portproxy
  const caddyPortOpen = await isPortOpen(caddyPort);
  const rule = portproxyRule(caddyPort);

  if (rule) {
    depChecks.push({
      name: `Port ${caddyPort} (Portproxy Conflict)`,
      status: 'warn',
      message: `Port ${caddyPort} is currently held by Windows portproxy (${rule.listenAddress}:${rule.listenPort} -> ${rule.connectAddress}:${rule.connectPort})`,
    });
    addRec('caddy-activate', 'Activate Caddy and migrate port 80', 'npm run caddy:activate',
      'Removes the legacy Windows portproxy rule, binds Caddy to port 80, and configures hosts aliases.', 'README.md: Portless local hostnames with Caddy');
  } else if (caddyPortOpen) {
    depChecks.push({
      name: `Port ${caddyPort} (Caddy HTTP)`,
      status: 'pass',
      message: `Port ${caddyPort} is actively listening (routing local hostnames)`,
    });
  } else {
    depChecks.push({
      name: `Port ${caddyPort} (Caddy HTTP)`,
      status: caddyExec ? 'warn' : 'info',
      message: `Port ${caddyPort} is not listening (Caddy is stopped)`,
    });
    if (caddyExec) {
      addRec('caddy-activate', 'Start Caddy on port 80', process.platform === 'win32' ? 'npm run caddy:activate' : 'npm run caddy:run',
        'Start Caddy to enable portless URLs such as http://cowfront.local and http://site.local.', 'README.md: Portless local hostnames with Caddy');
    }
  }

  categories.push({ id: 'dependencies', name: 'Core Dependencies & Services', checks: depChecks });

  // 3. Hosts File & Domain Aliases
  const hostChecks = [];
  const hostsData = parseHostsFile(hostsPath);

  if (!hostsData.exists) {
    hostChecks.push({
      name: 'Hosts File Existence',
      status: 'fail',
      message: `Hosts file not found at ${hostsPath}`,
    });
  } else {
    hostChecks.push({
      name: 'Hosts File Access',
      status: 'pass',
      message: `Hosts file found at ${hostsPath}`,
    });

    if (hostsData.hasManagedBlock) {
      hostChecks.push({
        name: 'Managed CowFront Block',
        status: 'pass',
        message: 'CowFront managed host aliases block is present',
      });
    } else {
      hostChecks.push({
        name: 'Managed CowFront Block',
        status: 'warn',
        message: 'CowFront managed block not found in hosts file',
      });
    }

    // Check standard hostnames
    const missingStandard = STANDARD_HOSTNAMES.filter((h) => !hostsData.mapped.has(h));

    // Also check custom distribution domains
    let customDomains = [];
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        const dists = Array.isArray(parsed.distributions) ? parsed.distributions : [];
        customDomains = dists
          .map((d) => String(d.domainName || '').trim().toLowerCase())
          .filter((h) => h && !h.endsWith('.localhost') && h !== 'localhost');
      } catch {}
    }
    const missingCustom = customDomains.filter((h) => !hostsData.mapped.has(h));
    const allMissing = [...new Set([...missingStandard, ...missingCustom])];

    if (allMissing.length === 0) {
      hostChecks.push({
        name: 'Domain Loopback Aliases',
        status: 'pass',
        message: `All hostnames mapped (${STANDARD_HOSTNAMES.length + customDomains.length} domains mapped to 127.0.0.1)`,
      });
    } else {
      hostChecks.push({
        name: 'Domain Loopback Aliases',
        status: 'warn',
        message: `Missing ${allMissing.length} hostname alias(es): ${allMissing.join(', ')}`,
      });
      addRec('hosts-setup', 'Setup Host Aliases in hosts file', 'npm run hosts:setup',
        'Adds loopback aliases (cowfront.local, site.local, etc.) to your hosts file and flushes DNS cache.', 'README.md: Friendly local hostnames');
    }
  }

  categories.push({ id: 'hosts', name: 'Network & Hostname Aliases', checks: hostChecks });

  // 4. CowFront Server & Ports
  const serverChecks = [];
  const adminOpen = await isPortOpen(adminPort);
  const proxyOpen = await isPortOpen(proxyPort);

  let adminHealthy = false;
  if (adminOpen) {
    try {
      const res = await fetch(`http://127.0.0.1:${adminPort}/health`, { signal: AbortSignal.timeout(350) });
      const data = await res.json().catch(() => ({}));
      adminHealthy = res.ok && data.ok === true;
    } catch {}
  }

  if (adminHealthy) {
    serverChecks.push({
      name: `Admin Dashboard & API (:${adminPort})`,
      status: 'pass',
      message: `CowFront Admin is healthy at http://127.0.0.1:${adminPort}/ (and http://cowfront.local/)`,
    });
  } else if (adminOpen) {
    serverChecks.push({
      name: `Admin Port (:${adminPort})`,
      status: 'warn',
      message: `Port ${adminPort} is open, but did not respond with healthy CowFront status`,
    });
  } else {
    serverChecks.push({
      name: `Admin Port (:${adminPort})`,
      status: 'info',
      message: `CowFront Admin server is stopped (port ${adminPort} free)`,
    });
  }

  if (proxyOpen) {
    serverChecks.push({
      name: `CDN Proxy Port (:${proxyPort})`,
      status: 'pass',
      message: `CowFront CDN proxy listening on port ${proxyPort}`,
    });
  } else {
    serverChecks.push({
      name: `CDN Proxy Port (:${proxyPort})`,
      status: 'info',
      message: `CowFront CDN proxy is not running on port ${proxyPort}`,
    });
  }

  if (!adminHealthy && !proxyOpen) {
    addRec('cowfront-serve', 'Start CowFront CDN & Admin Server', 'npm run serve',
      'Starts CowFront CDN emulator on port 8080 and Admin Dashboard on port 5744.', 'README.md: Quickstart step 3');
  }

  categories.push({ id: 'server', name: 'CowFront Server Status', checks: serverChecks });

  // 5. Distributions Configuration
  const distChecks = [];
  if (!existsSync(configPath)) {
    distChecks.push({
      name: 'Config File (distributions.json)',
      status: 'warn',
      message: `distributions.json not found at ${configPath}`,
    });
    addRec('create-dist', 'Create Sample Distribution', 'cowfront create-distribution --origin http://localhost:9000 --origin-path /assets --domain site.local',
      'Initializes a distribution pointing to your MinIO bucket.', 'README.md: Quickstart step 2');
  } else {
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      distChecks.push({
        name: 'Config File (distributions.json)',
        status: 'pass',
        message: `Valid JSON configuration at ${path.relative(root, configPath) || configPath}`,
      });
    } catch (err) {
      distChecks.push({
        name: 'Config File (distributions.json)',
        status: 'fail',
        message: `JSON syntax error in ${configPath}: ${err.message}`,
      });
    }

    if (parsedConfig) {
      const dists = Array.isArray(parsedConfig.distributions) ? parsedConfig.distributions : [];
      if (dists.length === 0) {
        distChecks.push({
          name: 'Configured Distributions',
          status: 'warn',
          message: 'No distributions configured yet',
        });
        addRec('create-dist', 'Create First Distribution', 'cowfront create-distribution --origin http://localhost:9000 --origin-path /assets --domain site.local',
          'Create a distribution pointing to your MinIO bucket.', 'README.md: Quickstart step 2');
      } else {
        distChecks.push({
          name: 'Configured Distributions',
          status: 'pass',
          message: `${dists.length} distribution(s) defined`,
        });

        // Check each distribution
        for (const d of dists) {
          const distId = d.id || 'unknown';
          const domain = d.domainName || `${distId}.localhost`;
          const originDomain = d.origin?.domainName || '';

          // Check functions existence if defined
          const fnAssoc = d.defaultCacheBehavior?.functionAssociations || {};
          const fnErrors = [];
          for (const [type, fnPath] of Object.entries(fnAssoc)) {
            if (!fnPath) continue;
            const resolvedPath = path.isAbsolute(fnPath) ? fnPath : path.resolve(path.dirname(configPath), fnPath);
            if (!existsSync(resolvedPath)) {
              if (d.functionCode?.[type]) {
                fnErrors.push(`${type}: ${fnPath} (missing on disk, but embedded in config for auto-restore)`);
              } else {
                fnErrors.push(`${type}: ${fnPath} (not found on disk)`);
              }
            }
          }

          if (fnErrors.length > 0) {
            distChecks.push({
              name: `Distribution ${distId} (${domain}) Functions`,
              status: 'warn',
              message: fnErrors.join('; '),
            });
          }
        }
      }
    }
  }

  categories.push({ id: 'distributions', name: 'Distributions & Origins', checks: distChecks });

  // Summary counts
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let infoCount = 0;

  for (const cat of categories) {
    for (const c of cat.checks) {
      if (c.status === 'pass') passCount++;
      else if (c.status === 'warn') warnCount++;
      else if (c.status === 'fail') failCount++;
      else if (c.status === 'info') infoCount++;
    }
  }

  return {
    ok: failCount === 0,
    timestamp: new Date().toISOString(),
    summary: {
      pass: passCount,
      warn: warnCount,
      fail: failCount,
      info: infoCount,
      total: passCount + warnCount + failCount + infoCount,
    },
    categories,
    recommendations,
  };
}

// ----------------------------------------------------------------------------- Terminal Formatting

export function formatAuditReport(auditResult, useColors = true) {
  const colors = {
    reset: useColors ? '\x1b[0m' : '',
    bold: useColors ? '\x1b[1m' : '',
    dim: useColors ? '\x1b[2m' : '',
    green: useColors ? '\x1b[32m' : '',
    yellow: useColors ? '\x1b[33m' : '',
    red: useColors ? '\x1b[31m' : '',
    cyan: useColors ? '\x1b[36m' : '',
    blue: useColors ? '\x1b[34m' : '',
  };

  const statusBadges = {
    pass: `${colors.green}[PASS]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    fail: `${colors.red}[FAIL]${colors.reset}`,
    info: `${colors.blue}[INFO]${colors.reset}`,
  };

  const lines = [];
  lines.push(`${colors.bold}${colors.cyan}=== CowFront Setup State Audit ===${colors.reset}\n`);

  for (const cat of auditResult.categories) {
    lines.push(`${colors.bold}${cat.name}${colors.reset}`);
    for (const chk of cat.checks) {
      const badge = statusBadges[chk.status] || `[${chk.status.toUpperCase()}]`;
      lines.push(`  ${badge} ${chk.name}: ${chk.message}`);
    }
    lines.push('');
  }

  lines.push('--------------------------------------------------');
  const sum = auditResult.summary;
  lines.push(
    `Audit Result: ${colors.green}${sum.pass} passed${colors.reset}, ` +
    `${colors.yellow}${sum.warn} warnings${colors.reset}, ` +
    `${sum.fail > 0 ? colors.red : colors.dim}${sum.fail} failed${colors.reset}` +
    (sum.info > 0 ? `, ${colors.dim}${sum.info} info${colors.reset}` : '')
  );

  if (auditResult.recommendations.length > 0) {
    lines.push(`\n${colors.bold}${colors.yellow}Recommended Actions (from README):${colors.reset}`);
    auditResult.recommendations.forEach((rec, idx) => {
      lines.push(`\n  ${idx + 1}. ${colors.bold}${rec.title}${colors.reset}`);
      if (rec.reason) lines.push(`     ${colors.dim}${rec.reason}${colors.reset}`);
      lines.push(`     ${colors.cyan}> ${rec.command}${colors.reset}`);
      if (rec.docRef) lines.push(`     ${colors.dim}(ref: ${rec.docRef})${colors.reset}`);
    });
    lines.push('');
  } else {
    lines.push(`\n${colors.green}${colors.bold}All checks passed! Your CowFront environment is fully configured.${colors.reset}\n`);
  }

  return lines.join('\n');
}

// ----------------------------------------------------------------------------- Direct Script Execution

if (process.argv[1] && (path.resolve(process.argv[1]) === path.resolve(__filename))) {
  const jsonMode = process.argv.includes('--json');
  runAudit().then((result) => {
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const useColors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
      console.log(formatAuditReport(result, useColors));
    }
    process.exit(result.ok ? 0 : 1);
  }).catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
