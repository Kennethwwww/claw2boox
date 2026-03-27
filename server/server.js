require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { Bonjour } = require('bonjour-service');
const pairing = require('./lib/pairing');
const { GatewayProxy } = require('./lib/ws-proxy');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '18789', 10);
const GATEWAY_PASSWORD = process.env.GATEWAY_PASSWORD || '';
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '300000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || os.hostname();
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');

// --- Initialize ---

pairing.initDB();

const gatewayUrl = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const proxy = new GatewayProxy(gatewayUrl, { password: GATEWAY_PASSWORD });

const app = express();
const server = http.createServer(app);

app.use(express.json());

// --- Auth middleware ---

function requireDevice(req, res, next) {
  const token = req.headers['x-device-token'] || req.query.token;
  const device = pairing.validateToken(token);
  if (!device) {
    return res.status(401).json({ error: 'Unauthorized. Device not paired.' });
  }
  req.device = device;
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// --- Discovery API (no auth - used by BOOX app to find and identify this server) ---

app.get('/api/discover', (req, res) => {
  res.json({
    service: 'claw2boox',
    version: '0.1.0',
    name: INSTANCE_NAME,
    paired_devices: pairing.getDeviceCount(),
    max_devices: pairing.MAX_DEVICES,
    accepting_pairing: pairing.getDeviceCount() < pairing.MAX_DEVICES,
  });
});

// --- Pairing API ---

app.post('/api/pair/generate', requireAdmin, (req, res) => {
  const result = pairing.generatePairCode();
  if (result.error) {
    return res.status(409).json(result);
  }
  console.log(`[pairing] Generated pair code: ${result.code} (expires in ${result.expires_in_seconds}s)`);
  res.json(result);
});

app.post('/api/pair/verify', (req, res) => {
  const { code, device } = req.body;
  if (!code || !device) {
    return res.status(400).json({ error: 'Missing code or device info.' });
  }
  const result = pairing.verifyAndPair(code, device);
  if (result.error) {
    return res.status(400).json(result);
  }
  console.log(`[pairing] Device paired: ${result.display_name} (${result.device_id})`);
  res.json(result);
});

app.get('/api/devices', requireAdmin, (req, res) => {
  res.json({ devices: pairing.listDevices(), max_devices: pairing.MAX_DEVICES });
});

app.delete('/api/devices/:id', requireAdmin, (req, res) => {
  const success = pairing.unpairDevice(req.params.id);
  if (!success) {
    return res.status(404).json({ error: 'Device not found.' });
  }
  console.log(`[pairing] Device unpaired: ${req.params.id}`);
  res.json({ success: true });
});

// --- Dashboard API (requires paired device) ---

app.get('/api/config', requireDevice, (req, res) => {
  res.json({
    refresh_interval_ms: REFRESH_INTERVAL_MS,
    gateway_connected: proxy.isConnected(),
    device: { id: req.device.id, display_name: req.device.display_name },
  });
});

app.get('/api/status', requireDevice, async (req, res) => {
  try {
    const [sessions, nodes] = await Promise.all([
      proxy.rpc('sessions.list').catch(() => ({ result: [] })),
      proxy.rpc('node.list').catch(() => ({ result: [] })),
    ]);
    res.json({
      gateway_connected: proxy.isConnected(),
      sessions: sessions.result || [],
      nodes: nodes.result || [],
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({
      gateway_connected: false, sessions: [], nodes: [],
      error: err.message, timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/briefings', requireDevice, async (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  try {
    const history = await proxy.rpc('sessions.history', { peer: 'claw2boox-briefing', limit });
    res.json({ messages: history.result || [], timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ messages: [], error: err.message, timestamp: new Date().toISOString() });
  }
});

// --- Static files ---

app.get('/dashboard', requireDevice, (req, res) => {
  res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
});
app.get('/dashboard/', requireDevice, (req, res) => {
  res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
});
app.use('/dashboard', express.static(DASHBOARD_DIR));
app.use('/pair', express.static(path.join(DASHBOARD_DIR, 'pair')));

app.get('/', (req, res) => {
  const token = req.query.token;
  if (token && pairing.validateToken(token)) {
    return res.redirect(`/dashboard?token=${token}`);
  }
  res.redirect('/pair');
});

// --- WebSocket ---

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }

  const token = url.searchParams.get('token');
  const device = pairing.validateToken(token);
  if (!device) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, device);
  });
});

wss.on('connection', (ws, request, device) => {
  console.log(`[ws] Device connected: ${device.display_name}`);
  proxy.attachClient(ws);
  ws.on('close', () => console.log(`[ws] Device disconnected: ${device.display_name}`));
});

// --- mDNS Service Advertisement ---

function startMDNS() {
  const bonjour = new Bonjour();

  bonjour.publish({
    name: `claw2boox-${INSTANCE_NAME}`,
    type: 'claw2boox',
    protocol: 'tcp',
    port: PORT,
    txt: {
      version: '0.1.0',
      instance: INSTANCE_NAME,
    },
  });

  console.log(`[mdns] Advertising _claw2boox._tcp on port ${PORT} as "${INSTANCE_NAME}"`);
  return bonjour;
}

// --- CLI: Pretty startup with auto pairing code ---

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

function printBanner(pairCode) {
  const ips = getLocalIPs();
  const mainIP = ips.length > 0 ? ips[0].address : 'localhost';

  const line = '═'.repeat(52);
  const thin = '─'.repeat(52);

  console.log('');
  console.log(`╔${line}╗`);
  console.log(`║${'claw2boox'.padStart(30).padEnd(52)}║`);
  console.log(`║${'OpenClaw Dashboard for BOOX'.padStart(39).padEnd(52)}║`);
  console.log(`╠${line}╣`);

  if (pairCode) {
    const codeDisplay = pairCode.split('').join(' ');
    console.log(`║                                                    ║`);
    console.log(`║${'配对码 (Pairing Code):'.padStart(36).padEnd(52)}║`);
    console.log(`║                                                    ║`);
    console.log(`║${codeDisplay.padStart(32).padEnd(52)}║`);
    console.log(`║                                                    ║`);
    console.log(`║${'在 BOOX App 中输入以上数字即可完成配对'.padStart(44).padEnd(52)}║`);
    console.log(`║${'5 分钟内有效'.padStart(32).padEnd(52)}║`);
    console.log(`║                                                    ║`);
  } else {
    console.log(`║                                                    ║`);
    console.log(`║${'已有设备配对，无需新配对码'.padStart(38).padEnd(52)}║`);
    console.log(`║                                                    ║`);
  }

  console.log(`╠${line}╣`);
  console.log(`║  Server: http://${mainIP}:${PORT}`.padEnd(53) + '║');
  if (ips.length > 1) {
    for (let i = 1; i < ips.length; i++) {
      console.log(`║          http://${ips[i].address}:${PORT}`.padEnd(53) + '║');
    }
  }
  console.log(`║  mDNS:   ${INSTANCE_NAME} (auto-discoverable)`.padEnd(53) + '║');
  console.log(`╚${line}╝`);
  console.log('');
}

// --- Start ---

async function start() {
  // Connect to gateway in background (don't block server startup)
  proxy.connectToGateway()
    .then(() => console.log('[server] Connected to OpenClaw gateway'))
    .catch((err) => {
      console.warn(`[server] Gateway not available at ${gatewayUrl} — will retry in background`);
    });

  server.listen(PORT, '0.0.0.0', () => {
    // Start mDNS advertisement
    startMDNS();

    // Auto-generate pairing code if no devices are paired
    let pairCode = null;
    if (pairing.getDeviceCount() === 0) {
      const result = pairing.generatePairCode();
      if (!result.error) {
        pairCode = result.code;
      }
    }

    printBanner(pairCode);

    // If pair code was generated, set up auto-refresh
    if (pairCode) {
      // Regenerate code every 4.5 minutes (before 5min expiry)
      const refreshTimer = setInterval(() => {
        if (pairing.getDeviceCount() > 0) {
          clearInterval(refreshTimer);
          console.log('[pairing] Device paired! Pairing code refresh stopped.');
          return;
        }
        const result = pairing.generatePairCode();
        if (!result.error) {
          console.log(`[pairing] New pairing code: ${result.code.split('').join(' ')}  (5 min)`);
        }
      }, 270000); // 4.5 minutes
    }
  });
}

// Support being imported as a module (for OpenClaw plugin integration)
if (require.main === module) {
  start();
} else {
  module.exports = { app, server, start, proxy, pairing };
}
