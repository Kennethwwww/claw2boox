// claw2boox Dashboard - Main App

(function () {
  'use strict';

  const TOKEN_KEY = 'claw2boox_token';

  function getToken() {
    // Priority: URL param > native bridge > localStorage
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      try { localStorage.setItem(TOKEN_KEY, urlToken); } catch (e) {}
      return urlToken;
    }
    // Try native bridge (BOOX WebView)
    try {
      if (window.Claw2Boox && window.Claw2Boox.getToken) {
        const nativeToken = window.Claw2Boox.getToken();
        if (nativeToken) return nativeToken;
      }
    } catch (e) {}
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  const token = getToken();
  if (!token) {
    location.href = '/pair';
    return;
  }

  // Init panels
  StatusPanel.init();
  NodesPanel.init();
  BriefingPanel.init();

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const lastUpdate = document.getElementById('lastUpdate');
  const refreshBar = document.getElementById('refreshBar');

  // HTTP API helper
  async function apiFetch(path) {
    const res = await fetch(path, {
      headers: { 'X-Device-Token': token },
    });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      location.href = '/pair';
      return null;
    }
    return res.json();
  }

  // Refresh all data via HTTP API (more reliable than WS for periodic updates)
  let refreshInterval = 300000; // default 5min, overridden by config

  async function refreshAll() {
    refreshBar.classList.add('visible');

    try {
      const [statusData, briefingData] = await Promise.all([
        apiFetch('/api/status?token=' + encodeURIComponent(token)),
        apiFetch('/api/briefings?token=' + encodeURIComponent(token)),
      ]);

      if (statusData) {
        StatusPanel.render(statusData);
        NodesPanel.render(statusData.nodes);

        statusDot.className = 'status-dot ' + (statusData.gateway_connected ? 'online' : 'offline');
        statusText.textContent = statusData.gateway_connected ? '已连接' : '未连接';
      }

      if (briefingData) {
        BriefingPanel.render(briefingData.messages);
      }

      lastUpdate.textContent = '更新: ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      StatusPanel.renderError();
      statusDot.className = 'status-dot offline';
      statusText.textContent = '离线';
    }

    setTimeout(() => {
      refreshBar.classList.remove('visible');
    }, 1000);
  }

  // WebSocket for real-time events
  const wsClient = new ClawWSClient(token);

  wsClient.on('connected', () => {
    statusDot.className = 'status-dot online';
    statusText.textContent = '已连接';
    // Refresh data on reconnect (e.g., after BOOX wakes from sleep)
    refreshAll();
  });

  wsClient.on('disconnected', () => {
    statusDot.className = 'status-dot offline';
    statusText.textContent = '重连中...';
  });

  // Handle real-time events from gateway
  wsClient.on('message', (msg) => {
    if (msg.type === 'event' || msg.type === 'notification') {
      // Trigger a refresh when we get a push event
      refreshAll();
    }
  });

  // Handle visibility change (BOOX sleep/wake)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      wsClient.connect();
      refreshAll();
    }
  });

  // Load config and start
  async function init() {
    try {
      const config = await apiFetch('/api/config?token=' + encodeURIComponent(token));
      if (config) {
        refreshInterval = config.refresh_interval_ms || refreshInterval;
      }
    } catch (e) {
      // Use defaults
    }

    // Initial load
    await refreshAll();

    // Connect WebSocket
    wsClient.connect();

    // Periodic refresh
    setInterval(refreshAll, refreshInterval);
  }

  init();
})();
