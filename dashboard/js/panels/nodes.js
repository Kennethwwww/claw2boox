const NodesPanel = {
  el: null,
  countEl: null,
  bodyEl: null,
  arrowEl: null,
  collapsed: false,

  init() {
    this.el = document.getElementById('nodeList');
    this.countEl = document.getElementById('nodeCount');
    this.bodyEl = document.getElementById('nodesBody');
    this.arrowEl = document.getElementById('nodesArrow');

    // Toggle collapse
    const toggle = document.getElementById('nodesToggle');
    if (toggle) {
      toggle.addEventListener('click', () => this.toggle());
    }
  },

  toggle() {
    this.collapsed = !this.collapsed;
    if (this.bodyEl) {
      this.bodyEl.classList.toggle('collapsed', this.collapsed);
    }
    if (this.arrowEl) {
      this.arrowEl.innerHTML = this.collapsed ? '&#x25B6;' : '&#x25BC;';
    }
  },

  render(nodes) {
    if (!nodes || nodes.length === 0) {
      EInk.batchUpdate(this.el, '<li class="empty-state-sm">暂无设备节点</li>');
      this.countEl.textContent = '';
      return;
    }

    this.countEl.textContent = `(${nodes.length})`;

    const html = nodes
      .map((node) => {
        const online = node.online !== false;
        const name = EInk.escapeHtml(node.name || node.id || '未知');
        const platform = EInk.escapeHtml(node.platform || '');
        const lastSeen = node.lastSeen ? TimeUtil.formatRelative(node.lastSeen) : '';

        return `<li>
          <span class="status-dot ${online ? 'online' : 'offline'}"></span>
          <span class="node-name">${name}</span>
          <span class="node-detail">${platform}${lastSeen ? ' · ' + lastSeen : ''}</span>
        </li>`;
      })
      .join('');

    EInk.batchUpdate(this.el, html);
  },
};
