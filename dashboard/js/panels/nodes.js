const NodesPanel = {
  el: null,
  countEl: null,

  init() {
    this.el = document.getElementById('nodeList');
    this.countEl = document.getElementById('nodeCount');
  },

  render(nodes) {
    if (!nodes || nodes.length === 0) {
      EInk.batchUpdate(this.el, '<li class="empty-state">暂无设备节点</li>');
      this.countEl.textContent = '';
      return;
    }

    this.countEl.textContent = `${nodes.length} 个`;

    const html = nodes
      .map((node) => {
        const online = node.online !== false;
        const name = EInk.escapeHtml(node.name || node.id || '未知设备');
        const platform = EInk.escapeHtml(node.platform || '');
        const lastSeen = node.lastSeen ? TimeUtil.formatRelative(node.lastSeen) : '';

        return `
      <li>
        <div class="item-name">
          <span class="status-dot ${online ? 'online' : 'offline'}"></span>
          ${name}
        </div>
        <div class="item-detail">${platform}${lastSeen ? ' · ' + lastSeen : ''}</div>
      </li>`;
      })
      .join('');

    EInk.batchUpdate(this.el, html);
  },
};
