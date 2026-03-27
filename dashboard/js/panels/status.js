const StatusPanel = {
  elSessions: null,
  elNodes: null,
  elGateway: null,

  init() {
    this.elSessions = document.getElementById('statSessions');
    this.elNodes = document.getElementById('statNodes');
    this.elGateway = document.getElementById('statGateway');
  },

  render(data) {
    const sessions = (data.sessions || []).length;
    const nodes = data.nodes || [];
    const onlineNodes = nodes.filter((n) => n.online !== false).length;
    const connected = data.gateway_connected;

    this.elSessions.textContent = String(sessions);
    this.elNodes.textContent = onlineNodes + '/' + nodes.length;
    this.elGateway.textContent = connected ? '已连接' : '未连接';
  },

  renderError() {
    this.elSessions.textContent = '--';
    this.elNodes.textContent = '--';
    this.elGateway.textContent = '离线';
  },
};
