const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Load OpenClaw device identity from ~/.openclaw/identity/
 * Returns { deviceId, token, publicKeyPem, privateKeyPem } or null
 */
function loadOpenClawIdentity() {
  const openclawDir = path.join(os.homedir(), '.openclaw');
  const authFile = path.join(openclawDir, 'identity', 'device-auth.json');
  const deviceFile = path.join(openclawDir, 'identity', 'device.json');

  try {
    if (!fs.existsSync(authFile) || !fs.existsSync(deviceFile)) {
      return null;
    }

    const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    const device = JSON.parse(fs.readFileSync(deviceFile, 'utf-8'));

    if (!auth.deviceId || !auth.tokens?.operator?.token) {
      return null;
    }

    return {
      deviceId: auth.deviceId,
      token: auth.tokens.operator.token,
      role: auth.tokens.operator.role || 'operator',
      scopes: auth.tokens.operator.scopes || ['operator.read'],
      publicKeyPem: device.publicKeyPem || null,
      privateKeyPem: device.privateKeyPem || null,
    };
  } catch (e) {
    return null;
  }
}

class GatewayProxy {
  constructor(gatewayUrl, options = {}) {
    this.gatewayUrl = gatewayUrl;
    this.password = options.password || '';
    this.deviceToken = options.deviceToken || '';
    this.gateway = null;
    this.client = null;
    this.reconnectTimer = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.connected = false;
    this.authenticated = false;
    this.lastStatus = null;
    this.fatalError = null;

    // Auto-detect OpenClaw identity
    this.identity = loadOpenClawIdentity();
    if (this.identity) {
      console.log(`[gateway] Found OpenClaw device identity: ${this.identity.deviceId.substring(0, 12)}...`);
    }

    // Exponential backoff
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 120000;
    this.currentDelay = this.reconnectDelay;
    this.consecutiveFailures = 0;
  }

  _buildConnectParams() {
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        version: '0.1.0',
        platform: 'nodejs',
        mode: 'backend',
      },
      role: 'operator',
      scopes: ['operator.read'],
    };

    // Auth: prefer device token from identity, then CLI flag, then password
    if (this.identity) {
      params.auth = { token: this.identity.token };

      // Device identity with signed nonce (required by Gateway)
      const nonce = crypto.randomBytes(32).toString('hex');
      const signedAt = Date.now();
      params.device = {
        id: this.identity.deviceId,
        nonce,
        signedAt,
      };

      // Sign nonce with Ed25519 private key
      if (this.identity.privateKeyPem) {
        try {
          const privateKey = crypto.createPrivateKey(this.identity.privateKeyPem);
          const payload = `${nonce}:${signedAt}`;
          const signature = crypto.sign(null, Buffer.from(payload), privateKey);
          params.device.signature = signature.toString('base64');
        } catch (e) {
          // Try signing just the nonce
          try {
            const privateKey = crypto.createPrivateKey(this.identity.privateKeyPem);
            const signature = crypto.sign(null, Buffer.from(nonce), privateKey);
            params.device.signature = signature.toString('base64');
          } catch (e2) {
            console.error('[gateway] Failed to sign device identity:', e2.message);
          }
        }
      }
    } else if (this.deviceToken) {
      params.auth = { token: this.deviceToken };
    } else if (this.password) {
      params.auth = { password: this.password };
    } else {
      params.auth = {};
    }

    return params;
  }

  connectToGateway() {
    return new Promise((resolve, reject) => {
      if (this.fatalError) {
        reject(new Error(this.fatalError));
        return;
      }

      if (this.gateway && this.gateway.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.gateway) {
        try { this.gateway.removeAllListeners(); this.gateway.close(); } catch (e) {}
      }

      this.gateway = new WebSocket(this.gatewayUrl);

      this.gateway.on('open', () => {
        this.connected = true;
        this.currentDelay = this.reconnectDelay;
        this.consecutiveFailures = 0;
        console.log('[gateway] Connected to OpenClaw');

        const connectReq = {
          type: 'req',
          id: `claw2boox-connect-${++this.requestId}`,
          method: 'connect',
          params: this._buildConnectParams(),
        };

        this.gateway.send(JSON.stringify(connectReq));
        resolve();
      });

      this.gateway.on('message', (data) => {
        this._handleGatewayMessage(data.toString());
      });

      this.gateway.on('close', (code, reason) => {
        this.connected = false;
        this.authenticated = false;
        this.consecutiveFailures++;

        const reasonStr = reason ? reason.toString() : '';

        if (this.consecutiveFailures <= 1) {
          console.log(`[gateway] Connection closed (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''})`);
        }

        // Fatal: device identity required and we don't have one
        if (reasonStr.includes('device identity required') || reasonStr.includes('NOT_PAIRED')) {
          if (!this.identity && !this.deviceToken) {
            if (this.consecutiveFailures <= 1) {
              console.log('');
              console.log('[gateway] ⚠ OpenClaw Gateway requires device identity.');
              console.log('[gateway] Could not find ~/.openclaw/identity/ files.');
              console.log('[gateway]');
              console.log('[gateway] Make sure OpenClaw has been onboarded on this machine:');
              console.log('[gateway]   openclaw onboard --install-daemon');
              console.log('[gateway]');
              console.log('[gateway] Dashboard will still work — Gateway status will show "未连接".');
              console.log('');
            }
            this.fatalError = 'NOT_PAIRED';
            return;
          }
        }

        // Fatal: invalid connect params — don't retry
        if (reasonStr.includes('invalid connect params')) {
          if (this.consecutiveFailures <= 1) {
            console.log('[gateway] Invalid connect params — protocol mismatch');
          }
          this.fatalError = 'INVALID_PARAMS';
          return;
        }

        if (this.consecutiveFailures >= 3 && this.consecutiveFailures % 10 === 0) {
          console.log(`[gateway] Still retrying... (attempt ${this.consecutiveFailures})`);
        }

        this._scheduleReconnect();
      });

      this.gateway.on('error', (err) => {
        this.connected = false;
        if (this.consecutiveFailures <= 0) {
          console.error('[gateway] Connection error:', err.message);
        }
        reject(err);
      });
    });
  }

  _handleGatewayMessage(rawMsg) {
    try {
      const msg = JSON.parse(rawMsg);
      console.log('[gateway] <<< MSG:', JSON.stringify(msg).substring(0, 300));

      // Handle connect response — detect auth success broadly
      if (msg.id && msg.id.startsWith('claw2boox-connect')) {
        if (msg.type === 'res' && msg.ok !== false) {
          this.authenticated = true;
          const proto = msg.payload?.protocol || msg.protocol || '?';
          console.log(`[gateway] Authenticated successfully (protocol v${proto})`);
          return;
        }
      }

      // Also handle hello-ok payload format
      if (msg.type === 'res' && msg.payload && msg.payload.type === 'hello-ok') {
        this.authenticated = true;
        console.log('[gateway] Authenticated via hello-ok (protocol v' + (msg.payload.protocol || '?') + ')');
        return;
      }

      // Also handle: gateway sends a welcome/connected event (no id field)
      if ((msg.type === 'connected' || msg.type === 'welcome' || msg.method === 'connected') && !this.authenticated) {
        this.authenticated = true;
        console.log('[gateway] Authenticated via welcome/connected message');
        return;
      }

      // Handle challenge-response flow
      if (msg.method === 'connect.challenge' || (msg.type === 'msg' && msg.nonce)) {
        this._respondToChallenge(msg);
        return;
      }

      // Handle error responses
      if (msg.type === 'res' && !msg.ok) {
        const errMsg = msg.error || msg.payload?.error || 'unknown error';
        if (msg.error?.code !== 'NOT_PAIRED') {
          console.error('[gateway] Request failed:', typeof errMsg === 'object' ? JSON.stringify(errMsg) : errMsg);
        }
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }
        return;
      }

      // Handle RPC responses
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve } = this.pendingRequests.get(msg.id);
        this.pendingRequests.delete(msg.id);
        resolve(msg);
      }

      // Forward events to connected BOOX client
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(rawMsg);
      }

      // Cache status updates
      if (msg.type === 'event' && (msg.event === 'status' || msg.event === 'state')) {
        this.lastStatus = msg;
      }
    } catch (e) {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(rawMsg);
      }
    }
  }

  _respondToChallenge(challengeMsg) {
    const nonce = challengeMsg.nonce;
    const params = this._buildConnectParams();

    // Sign the nonce with Ed25519 private key if available
    if (this.identity?.privateKeyPem) {
      try {
        const privateKey = crypto.createPrivateKey(this.identity.privateKeyPem);
        const signature = crypto.sign(null, Buffer.from(nonce), privateKey);
        params.device = params.device || {};
        params.device.nonce = nonce;
        params.device.signature = signature.toString('base64');
        params.device.signedAt = Date.now();
      } catch (e) {
        console.error('[gateway] Failed to sign challenge:', e.message);
      }
    }

    const connectReq = {
      type: 'req',
      id: `claw2boox-connect-${++this.requestId}`,
      method: 'connect',
      params,
    };

    this.gateway.send(JSON.stringify(connectReq));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.fatalError) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToGateway().catch(() => {});
      this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxReconnectDelay);
    }, this.currentDelay);
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.gateway || this.gateway.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = `claw2boox-${++this.requestId}`;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('RPC timeout'));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
      });

      this.gateway.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  attachClient(clientWs) {
    this.client = clientWs;

    clientWs.on('message', (data) => {
      if (this.gateway && this.gateway.readyState === WebSocket.OPEN) {
        this.gateway.send(data.toString());
      }
    });

    clientWs.on('close', () => {
      if (this.client === clientWs) {
        this.client = null;
      }
    });

    if (this.lastStatus) {
      clientWs.send(JSON.stringify(this.lastStatus));
    }
  }

  isConnected() {
    return this.connected && this.authenticated && this.gateway && this.gateway.readyState === WebSocket.OPEN;
  }

  getStatus() {
    if (this.fatalError === 'NOT_PAIRED') return 'not_paired';
    if (this.fatalError) return 'error';
    if (this.authenticated) return 'connected';
    if (this.connected) return 'connecting';
    return 'disconnected';
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.gateway) this.gateway.close();
    this.pendingRequests.clear();
  }
}

module.exports = { GatewayProxy };
