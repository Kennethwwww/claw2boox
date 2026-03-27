const WebSocket = require('ws');

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
    this.maxReconnectDelay = 120000; // 2 min max
    this.currentDelay = this.reconnectDelay;
    this.consecutiveFailures = 0;
  }

  connectToGateway() {
    return new Promise((resolve, reject) => {
      if (this.gateway && this.gateway.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      // Clean up previous connection
      if (this.gateway) {
        try { this.gateway.removeAllListeners(); this.gateway.close(); } catch (e) {}
      }

      this.gateway = new WebSocket(this.gatewayUrl);

      this.gateway.on('open', () => {
        this.connected = true;
        this.currentDelay = this.reconnectDelay; // Reset backoff on success
        this.consecutiveFailures = 0;

        if (this.consecutiveFailures === 0) {
          console.log('[gateway] Connected to OpenClaw');
        }

        // Step 1: Send connect params — wait for gateway's response before considering "authenticated"
        const connectParams = {
          type: 'connect',
          role: 'operator',
          scopes: ['operator.read'],
        };
        if (this.password) {
          connectParams.password = this.password;
        }
        this.gateway.send(JSON.stringify(connectParams));
        resolve();
      });

      this.gateway.on('message', (data) => {
        const msg = data.toString();
        this._handleGatewayMessage(msg);
      });

      this.gateway.on('close', (code, reason) => {
        const wasAuthenticated = this.authenticated;
        this.connected = false;
        this.authenticated = false;
        this.consecutiveFailures++;

        // Only log meaningful close events, not the reconnect spam
        if (this.consecutiveFailures <= 1) {
          const reasonStr = reason ? reason.toString() : '';
          console.log(`[gateway] Connection closed (code: ${code}${reasonStr ? ', reason: ' + reasonStr : ''})`);

          if (code === 1008 || code === 4001 || code === 4003) {
            console.log('[gateway] Authentication failed — check your --password flag or GATEWAY_PASSWORD env var');
          } else if (code === 1006) {
            console.log('[gateway] Connection lost unexpectedly — gateway may have restarted');
          }
        } else if (this.consecutiveFailures === 3) {
          console.log(`[gateway] Repeated connection failures. Backing off. (retry every ${Math.round(this.currentDelay / 1000)}s)`);
        }

        this._scheduleReconnect();
      });

      this.gateway.on('error', (err) => {
        this.connected = false;
        // Only log the first error, not every reconnect attempt
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

      // Detect successful authentication
      if (msg.type === 'hello-ok' || msg.type === 'connected' || msg.type === 'welcome') {
        this.authenticated = true;
        console.log('[gateway] Authenticated successfully');
      }

      // Handle nonce challenge (OpenClaw auth protocol)
      if (msg.type === 'challenge' && msg.nonce) {
        this._respondToChallenge(msg);
        return;
      }

      // Handle auth errors
      if (msg.type === 'error' && msg.error) {
        console.error('[gateway] Server error:', msg.error);
        if (msg.error.includes('auth') || msg.error.includes('password') || msg.error.includes('denied')) {
          console.error('[gateway] → Check your --password flag');
        }
        return;
      }

      // Handle RPC responses
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve } = this.pendingRequests.get(msg.id);
        this.pendingRequests.delete(msg.id);
        resolve(msg);
      }

      // Forward all messages to connected BOOX client
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(rawMsg);
      }

      // Cache status updates
      if (msg.type === 'status' || msg.method === 'status') {
        this.lastStatus = msg;
      }
    } catch (e) {
      // Forward raw messages too
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.send(rawMsg);
      }
    }
  }

  _respondToChallenge(challengeMsg) {
    // OpenClaw uses nonce-based challenge-response
    // For read-only operator, respond with the nonce signed by password
    const crypto = require('crypto');
    const response = {
      type: 'challenge-response',
      nonce: challengeMsg.nonce,
    };

    if (this.password) {
      response.signature = crypto
        .createHmac('sha256', this.password)
        .update(challengeMsg.nonce)
        .digest('hex');
    }

    this.gateway.send(JSON.stringify(response));
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToGateway().catch(() => {});

      // Exponential backoff
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

    // Send cached status immediately
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
