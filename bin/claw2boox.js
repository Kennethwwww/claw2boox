#!/usr/bin/env node

/**
 * claw2boox CLI — zero-config entry point
 *
 * Usage:
 *   npx claw2boox                          # auto-detect local OpenClaw gateway
 *   npx claw2boox --gateway 192.168.1.5    # specify gateway host
 *   npx claw2boox --port 3001              # custom dashboard port
 *   npx claw2boox --password mypass        # gateway password
 *   npx claw2boox unpair                   # remove all paired devices
 *   npx claw2boox status                   # show current status
 */

const http = require('http');
const os = require('os');
const path = require('path');

// ── Parse CLI args ──────────────────────────────────────────

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-'));
const flags = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--gateway' || args[i] === '-g') flags.gateway = args[++i];
  else if (args[i] === '--port' || args[i] === '-p') flags.port = args[++i];
  else if (args[i] === '--password') flags.password = args[++i];
  else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
}

if (flags.help) {
  console.log(`
  claw2boox - OpenClaw Dashboard for BOOX

  Usage:
    npx claw2boox                        启动（自动检测本地 OpenClaw）
    npx claw2boox --gateway 192.168.1.5  指定 Gateway 地址
    npx claw2boox --port 3001            自定义端口（默认 3000）
    npx claw2boox --password <pass>      Gateway 密码
    npx claw2boox unpair                 解除所有已配对设备
    npx claw2boox status                 查看当前状态

  环境变量（可选）:
    GATEWAY_HOST       Gateway 地址（默认自动检测）
    GATEWAY_PORT       Gateway 端口（默认 18789）
    GATEWAY_PASSWORD   Gateway 密码
    DASHBOARD_PORT     Dashboard 端口（默认 3000）
`);
  process.exit(0);
}

// ── Set env vars from CLI flags (before loading server) ─────

if (flags.gateway) process.env.GATEWAY_HOST = flags.gateway;
if (flags.port) process.env.DASHBOARD_PORT = flags.port;
if (flags.password) process.env.GATEWAY_PASSWORD = flags.password;

// Use ~/.claw2boox/ for data storage (not project dir)
const DATA_DIR = path.join(os.homedir(), '.claw2boox');
process.env.CLAW2BOOX_DATA_DIR = DATA_DIR;

// ── Auto-detect Gateway ─────────────────────────────────────

async function probeGateway(host, port) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/`, { timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        resolve(body.includes('openclaw') || body.includes('OpenClaw') || res.statusCode === 200);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function detectGateway() {
  // Already specified via env or flag
  if (process.env.GATEWAY_HOST && process.env.GATEWAY_HOST !== '127.0.0.1') {
    return process.env.GATEWAY_HOST;
  }

  const port = process.env.GATEWAY_PORT || '18789';
  const candidates = ['127.0.0.1', 'localhost'];

  console.log('[detect] Searching for OpenClaw gateway...');

  for (const host of candidates) {
    const found = await probeGateway(host, port);
    if (found) {
      console.log(`[detect] Found OpenClaw gateway at ${host}:${port}`);
      return host;
    }
  }

  console.log('[detect] No local gateway found. Starting anyway (will retry in background).');
  return '127.0.0.1';
}

// ── Commands ────────────────────────────────────────────────

async function main() {
  if (command === 'unpair') {
    // Load pairing module and clear all devices
    process.env.GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
    const pairing = require('../server/lib/pairing');
    pairing.initDB();
    const devices = pairing.listDevices();
    if (devices.length === 0) {
      console.log('No paired devices found.');
    } else {
      for (const d of devices) {
        pairing.unpairDevice(d.id);
        console.log(`Unpaired: ${d.display_name} (${d.id})`);
      }
      console.log(`\nRemoved ${devices.length} device(s). Restart claw2boox to get a new pairing code.`);
    }
    process.exit(0);
  }

  if (command === 'status') {
    process.env.GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
    const pairing = require('../server/lib/pairing');
    pairing.initDB();
    const devices = pairing.listDevices();
    console.log('\nclaw2boox Status');
    console.log('─'.repeat(40));
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Paired devices: ${devices.length} / ${pairing.MAX_DEVICES}`);
    for (const d of devices) {
      console.log(`  • ${d.display_name} (${d.model}) — paired ${d.paired_at}${d.last_seen_at ? ', seen ' + d.last_seen_at : ''}`);
    }
    console.log('');
    process.exit(0);
  }

  // ── Default: start server ───────────────────────────────

  const gatewayHost = await detectGateway();
  process.env.GATEWAY_HOST = gatewayHost;

  // Load and start the server
  const { start } = require('../server/server.js');
  await start();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
