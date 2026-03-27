const WebSocket = require('ws');
const crypto = require('crypto');

class GatewayProxy {
  constructor(gatewayUrl, options = {}) {
    this.gatewayUrl = gatewayUrl;
    this.password = options.password || '';
    this.gateway = null;
    this.client = null;
    this.reconnectTimer = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.connected = false;
    this.authenticated = false;
    this.lastStatus = null;

    // Exponential backoff
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 120000;
    this.currentDelay = this.reconnectDelay;
    this.consecutiveFailures = 0;
  }

  connectToGateway() {
    return new Promise((resolve, reject) => {
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

        // Send connect request using the correct OpenClaw protocol format
        // client.id must be one of: cli, gateway-client, webchat, node-host, etc.
        // client.mode must be one of: cli, ui, backend, node, webchat, probe, test
        const connectReq = {
          type: 'req',
          id: `claw2boox-connect-${++this.requestId}`,
          method: 'connect',
          params: {
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
            auth: this.password
              ? { password: this.password }
              : {},
          },
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

        if (this.consecutiveFailures <= 1) {
          const reasonStr = reason ? reason.toString() : '';
          console.log(`[gateway] Connection closed (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''})`);

          if (code === 1008 || code === 4001 || code === 4003) {
            console.log('[gateway] Protocol/auth error — check Gateway password and protocol version');
          }
        } else if (this.consecutiveFailures === 3) {
          console.log(`[gateway] Repeated failures. Backing off (retry every ${Math.round(this.currentDelay / 1000)}s)`);
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

      // Handle connect response (hello-ok)
      if (msg.type === 'res' && msg.ok && msg.payload && msg.payload.type === 'hello-ok') {
        this.authenticated = true;
        console.log('[gateway] Authenticated successfully (protocol v' + (msg.payload.protocol || '?') + ')');
        return;
      }

      // Also handle simpler success responses to our connect request
      if (msg.type === 'res' && msg.ok && msg.id && msg.id.startsWith('claw2boox-connect')) {
        this.authenticated = true;
        console.log('[gateway] Authenticated successfully');
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
        console.error('[gateway] Request failed:', errMsg);
        // Still resolve pending requests so they don't hang
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

      // Forward events and other messages to connected BOOX client
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
    const connectReq = {
      type: 'req',
      id: `claw2boox-connect-${++this.requestId}`,
      method: 'connect',
      params: {
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
        auth: this.password
          ? { password: this.password }
          : {},
        device: {
          id: 'claw2boox-device',
          nonce,
          signedAt: Date.now(),
        },
      },
    };

    // If password is set, sign the nonce
    if (this.password) {
      connectReq.params.device.signature = crypto
        .createHmac('sha256', this.password)
        .update(nonce)
        .digest('hex');
    }

    this.gateway.send(JSON.stringify(connectReq));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
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
    return this.connected && this.gateway && this.gateway.readyState === WebSocket.OPEN;
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.gateway) this.gateway.close();
    this.pendingRequests.clear();
  }
}

module.exports = { GatewayProxy };
