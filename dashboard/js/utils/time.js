const TimeUtil = {
  // Format ISO string to readable Chinese time
  formatTime(isoString) {
    if (!isoString) return '--';
    const d = new Date(isoString);
    const now = new Date();
    const today = now.toDateString();
    const dateStr = d.toDateString();

    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (dateStr === today) {
      return '今天 ' + time;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (dateStr === yesterday.toDateString()) {
      return '昨天 ' + time;
    }

    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + time;
  },

  // Format as full datetime
  formatFull(isoString) {
    if (!isoString) return '--';
    const d = new Date(isoString);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  },

  // Relative time (e.g., "3分钟前")
  formatRelative(isoString) {
    if (!isoString) return '--';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);

    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  },
};
