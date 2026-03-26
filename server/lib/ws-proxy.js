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
    this.lastStatus = null;
  }

  connectToGateway() {
    return new Promise((resolve, reject) => {
      if (this.gateway && this.gateway.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.gateway = new WebSocket(this.gatewayUrl);

      this.gateway.on('open', () => {
        console.log('[ws-proxy] Connected to OpenClaw gateway');
        this.connected = true;

        // Send ConnectParams for operator read access
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

      this.gateway.on('close', () => {
        console.log('[ws-proxy] Gateway connection closed');
        this.connected = false;
        this._scheduleReconnect();
      });

      this.gateway.on('error', (err) => {
        console.error('[ws-proxy] Gateway error:', err.message);
        this.connected = false;
        reject(err);
      });
    });
  }

  _handleGatewayMessage(rawMsg) {
    try {
      const msg = JSON.parse(rawMsg);

      // Handle RPC responses
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve } = this.pendingRequests.get(msg.id);
        this.pendingRequests.delete(msg.id);
        resolve(msg);
      }

      // Forward all messages to connected client
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

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log('[ws-proxy] Attempting reconnect to gateway...');
      this.connectToGateway().catch(() => {});
    }, 5000);
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
      // Forward client messages to gateway
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
