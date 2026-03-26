require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const pairing = require('./lib/pairing');
const { GatewayProxy } = require('./lib/ws-proxy');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const GATEWAY_HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '18789', 10);
const GATEWAY_PASSWORD = process.env.GATEWAY_PASSWORD || '';
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS || '300000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// --- Initialize ---

pairing.initDB();

const gatewayUrl = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const proxy = new GatewayProxy(gatewayUrl, { password: GATEWAY_PASSWORD });

const app = express();
const server = http.createServer(app);

app.use(express.json());

// --- Auth middleware for device endpoints ---

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
  if (!ADMIN_TOKEN) {
    return next(); // No admin token configured, allow all
  }
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// --- Pairing API ---

// Generate a new pair code (called from OpenClaw side / CLI)
app.post('/api/pair/generate', requireAdmin, (req, res) => {
  const result = pairing.generatePairCode();
  if (result.error) {
    return res.status(409).json(result);
  }
  console.log(`[pairing] Generated pair code: ${result.code} (expires in ${result.expires_in_seconds}s)`);
  res.json(result);
});

// Verify pair code and register device (called from BOOX app)
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

// List paired devices (admin)
app.get('/api/devices', requireAdmin, (req, res) => {
  res.json({ devices: pairing.listDevices(), max_devices: pairing.MAX_DEVICES });
});

// Unpair a device (admin)
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
    device: {
      id: req.device.id,
      display_name: req.device.display_name,
    },
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
      gateway_connected: false,
      sessions: [],
      nodes: [],
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/briefings', requireDevice, async (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  try {
    const history = await proxy.rpc('sessions.history', {
      peer: 'claw2boox-briefing',
      limit,
    });
    res.json({ messages: history.result || [], timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ messages: [], error: err.message, timestamp: new Date().toISOString() });
  }
});

// --- Static files ---

// Dashboard entry point - validate token then serve index.html
app.get('/dashboard', requireDevice, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});
app.get('/dashboard/', requireDevice, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
});

// Dashboard static assets (JS/CSS) - public, no sensitive data
// Auth is enforced at API level (all /api/* endpoints require token)
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));

// Pairing page (no auth required)
app.use('/pair', express.static(path.join(__dirname, '..', 'dashboard', 'pair')));

// Root redirect
app.get('/', (req, res) => {
  const token = req.query.token;
  if (token && pairing.validateToken(token)) {
    return res.redirect(`/dashboard?token=${token}`);
  }
  res.redirect('/pair');
});

// --- WebSocket for real-time updates ---

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  // Validate device token from query param
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

  ws.on('close', () => {
    console.log(`[ws] Device disconnected: ${device.display_name}`);
  });
});

// --- Start ---

async function start() {
  try {
    await proxy.connectToGateway();
    console.log('[server] Connected to OpenClaw gateway');
  } catch (err) {
    console.warn(`[server] Could not connect to gateway at ${gatewayUrl}: ${err.message}`);
    console.warn('[server] Dashboard will show offline status. Will retry in background.');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] claw2boox server running on http://0.0.0.0:${PORT}`);
    console.log(`[server] Pairing page: http://localhost:${PORT}/pair`);
    console.log(`[server] Dashboard:    http://localhost:${PORT}/dashboard`);
  });
}

start();
