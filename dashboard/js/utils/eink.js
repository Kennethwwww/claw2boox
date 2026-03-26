// E-Ink rendering helpers - minimize DOM reflows for BOOX displays

const EInk = {
  // Batch DOM update inside rAF to minimize reflows
  batchUpdate(element, html) {
    requestAnimationFrame(() => {
      element.innerHTML = html;
    });
  },

  // Strip markdown/emoji for clean e-ink rendering
  formatForEink(text) {
    if (!text) return '';
    return text
      // Remove markdown bold/italic
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove markdown headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      // Remove emojis (common unicode ranges)
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '')
      .trim();
  },

  // Truncate text with ellipsis
  truncate(text, maxLen = 200) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
