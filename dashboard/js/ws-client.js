class ClawWSClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.currentDelay = this.reconnectDelay;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.listeners = new Map();
    this.reconnectTimer = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(this.token)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this.currentDelay = this.reconnectDelay;
      this._emit('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Handle RPC response
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
        }

        // Emit typed events
        if (msg.type) {
          this._emit(msg.type, msg);
        }
        this._emit('message', msg);
      } catch (e) {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit('disconnected');
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.connected = false;
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      // Exponential backoff
      this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxReconnectDelay);
    }, this.currentDelay);
  }

  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const id = `c2b-${++this.requestId}`;
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

      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach((cb) => cb(data));
    }
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}
