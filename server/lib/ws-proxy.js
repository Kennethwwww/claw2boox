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

      // Device identity base fields (nonce + signature added by challenge handler)
      params.device = {
        id: this.identity.deviceId,
        publicKey: this.identity.publicKeyPem,
      };
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
        console.log('[gateway] Connected to OpenClaw — waiting for challenge...');
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

        // Invalid connect params — log but allow retry (challenge flow may fix it)
        if (reasonStr.includes('invalid connect params')) {
          if (this.consecutiveFailures <= 2) {
            console.log('[gateway] Invalid connect params:', reasonStr);
          }
          // Only fatal after multiple retries
          if (this.consecutiveFailures >= 5) {
            this.fatalError = 'INVALID_PARAMS';
            console.log('[gateway] Giving up after repeated invalid connect params');
            return;
          }
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
      // Gateway sends: {type:"event", event:"connect.challenge", payload:{nonce, ts}}
      if (msg.event === 'connect.challenge' || msg.method === 'connect.challenge' || (msg.type === 'msg' && msg.nonce)) {
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
    // Extract nonce from Gateway challenge
    const challengeNonce = challengeMsg.payload?.nonce || challengeMsg.nonce;

    if (!challengeNonce) {
      console.error('[gateway] Challenge received but no nonce found:', JSON.stringify(challengeMsg).substring(0, 200));
      return;
    }

    console.log('[gateway] Responding to challenge with Gateway nonce:', challengeNonce.substring(0, 16) + '...');

    const params = this._buildConnectParams();

    // Sign with the structured v2 payload format expected by OpenClaw Gateway
    // Format: v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
    if (this.identity?.privateKeyPem && params.device) {
      try {
        const privateKey = crypto.createPrivateKey(this.identity.privateKeyPem);
        const signedAt = Date.now();

        const deviceId = this.identity.deviceId;
        const clientId = params.client.id;
        const clientMode = params.client.mode;
        const role = params.role;
        const scopes = params.scopes.join(',');
        const token = this.identity.token || '';

        const payload = ['v2', deviceId, clientId, clientMode, role, scopes, String(signedAt), token, challengeNonce].join('|');

        console.log('[gateway] Signing payload:', payload.substring(0, 80) + '...');

        const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
        // Use base64url encoding (Gateway expects base64url, but also accepts standard base64)
        const signatureB64 = signature.toString('base64url');

        params.device.nonce = challengeNonce;
        params.device.signedAt = signedAt;
        params.device.signature = signatureB64;
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
