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

  // DOM elements
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const lastUpdate = document.getElementById('lastUpdate');
  const refreshBar = document.getElementById('refreshBar');
  const menuOverlay = document.getElementById('menuOverlay');

  // --- HTTP API helper ---

  async function apiFetch(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(path + sep + 'token=' + encodeURIComponent(token), {
      headers: { 'X-Device-Token': token },
    });
    if (res.status === 401) {
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
      location.href = '/pair';
      return null;
    }
    return res.json();
  }

  // --- Refresh ---

  let refreshInterval = 300000;
  let refreshTimer = null;
  let isRefreshing = false;

  async function refreshAll() {
    if (isRefreshing) return;
    isRefreshing = true;
    refreshBar.classList.add('visible');

    try {
      const [statusData, briefingData] = await Promise.all([
        apiFetch('/api/status'),
        apiFetch('/api/briefings'),
      ]);

      if (statusData) {
        StatusPanel.render(statusData);
        NodesPanel.render(statusData.nodes);

        const connected = statusData.gateway_connected;
        statusDot.className = 'status-dot ' + (connected ? 'online' : 'offline');
        statusText.textContent = connected ? '已连接' : '未连接';
      }

      if (briefingData) {
        BriefingPanel.render(briefingData.messages);
      }

      lastUpdate.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      StatusPanel.renderError();
      statusDot.className = 'status-dot offline';
      statusText.textContent = '离线';
    }

    isRefreshing = false;
    setTimeout(() => refreshBar.classList.remove('visible'), 800);
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refreshAll, refreshInterval);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // --- WebSocket ---

  const wsClient = new ClawWSClient(token);

  wsClient.on('connected', () => {
    statusDot.className = 'status-dot online';
    statusText.textContent = '已连接';
    refreshAll();
  });

  wsClient.on('disconnected', () => {
    statusDot.className = 'status-dot offline';
    statusText.textContent = '重连中...';
  });

  wsClient.on('message', (msg) => {
    if (msg.type === 'event' || msg.type === 'notification') {
      refreshAll();
    }
  });

  // --- Visibility change (BOOX sleep/wake) ---

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      wsClient.connect();
      refreshAll();
      startAutoRefresh();
    }
  });

  // --- Menu ---

  function showMenu() {
    menuOverlay.classList.add('visible');
  }

  function hideMenu() {
    menuOverlay.classList.remove('visible');
  }

  document.getElementById('btnMenu').addEventListener('click', showMenu);
  document.getElementById('menuClose').addEventListener('click', hideMenu);
  menuOverlay.addEventListener('click', (e) => {
    if (e.target === menuOverlay) hideMenu();
  });

  // Refresh button (header)
  document.getElementById('btnRefresh').addEventListener('click', () => {
    refreshAll();
  });

  // Menu: Refresh
  document.getElementById('menuRefresh').addEventListener('click', () => {
    hideMenu();
    refreshAll();
  });

  // Menu: Reconnect
  document.getElementById('menuReconnect').addEventListener('click', () => {
    hideMenu();
    statusText.textContent = '重连中...';
    statusDot.className = 'status-dot offline';
    wsClient.close();
    setTimeout(() => {
      wsClient.connect();
      refreshAll();
    }, 500);
  });

  // Menu: Disconnect
  document.getElementById('menuDisconnect').addEventListener('click', () => {
    hideMenu();
    wsClient.close();
    stopAutoRefresh();
    statusDot.className = 'status-dot offline';
    statusText.textContent = '已断开';
    lastUpdate.textContent = '手动断开';
  });

  // Menu: Unpair
  document.getElementById('menuUnpair').addEventListener('click', () => {
    if (!confirm('确认取消配对？设备将需要重新配对才能使用。')) return;
    hideMenu();
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    // Notify native bridge
    try {
      if (window.Claw2Boox && window.Claw2Boox.onUnpaired) {
        window.Claw2Boox.onUnpaired();
      }
    } catch (e) {}
    location.href = '/pair';
  });

  // --- Init ---

  async function init() {
    try {
      const config = await apiFetch('/api/config');
      if (config) {
        refreshInterval = config.refresh_interval_ms || refreshInterval;
      }
    } catch (e) {
      // Use defaults
    }

    await refreshAll();
    wsClient.connect();
    startAutoRefresh();
  }

  init();
})();
