const StatusPanel = {
  el: null,

  init() {
    this.el = document.getElementById('statusList');
  },

  render(data) {
    const items = [
      {
        name: 'Gateway 连接',
        value: data.gateway_connected ? '已连接' : '未连接',
        dot: data.gateway_connected,
      },
      {
        name: '活跃会话',
        value: `${(data.sessions || []).length} 个`,
      },
      {
        name: '在线节点',
        value: `${(data.nodes || []).filter((n) => n.online !== false).length} / ${(data.nodes || []).length} 个`,
      },
      {
        name: '最后更新',
        value: TimeUtil.formatTime(data.timestamp),
      },
    ];

    const html = items
      .map(
        (item) => `
      <li>
        <span class="item-name">${item.dot !== undefined ? '<span class="status-dot ' + (item.dot ? 'online' : 'offline') + '"></span>' : ''}${EInk.escapeHtml(item.name)}</span>
        <span class="item-detail">${EInk.escapeHtml(item.value)}</span>
      </li>`
      )
      .join('');

    EInk.batchUpdate(this.el, html);
  },

  renderError() {
    EInk.batchUpdate(this.el, '<li class="empty-state">无法获取状态</li>');
  },
};
