const BriefingPanel = {
  el: null,
  countEl: null,

  init() {
    this.el = document.getElementById('briefingList');
    this.countEl = document.getElementById('briefingCount');
  },

  render(messages) {
    if (!messages || messages.length === 0) {
      EInk.batchUpdate(this.el, '<div class="empty-state">暂无简报。在 OpenClaw 中配置 cron 任务来推送简报。</div>');
      this.countEl.textContent = '';
      return;
    }

    this.countEl.textContent = `${messages.length} 条`;

    const html = messages
      .map((msg) => {
        const time = TimeUtil.formatTime(msg.timestamp || msg.created_at);
        const content = EInk.escapeHtml(
          EInk.truncate(EInk.formatForEink(msg.content || msg.text || msg.body || ''), 500)
        );
        const source = msg.source || msg.from || '';

        return `
      <div class="briefing-item">
        <div class="briefing-time">${EInk.escapeHtml(time)}${source ? ' · ' + EInk.escapeHtml(source) : ''}</div>
        <div class="briefing-content">${content}</div>
      </div>`;
      })
      .join('');

    EInk.batchUpdate(this.el, html);
  },
};
