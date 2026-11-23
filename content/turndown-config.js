// turndown-config.js — TurndownService instance with WeChat-specific custom rules

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  linkReferenceStyle: 'full'
});

// Remove tracking pixels (1x1 images, read-stat images)
turndownService.addRule('removeTracking', {
  filter: function (node) {
    if (node.nodeName !== 'IMG') return false;
    const src = node.getAttribute('src') || '';
    return src.includes('mp.weixin.qq.com/mp/read') || src.includes('mmbiz.qpic.cn/mmbiz_png/0');

  },
  replacement: function () {
    return '';
  }
});

// Handle WeChat emoji images (replace with alt text)
turndownService.addRule('wechatEmoji', {
  filter: function (node) {
    if (node.nodeName !== 'IMG') return false;
    const src = node.getAttribute('src') || '';
    const alt = node.getAttribute('alt') || '';
    return src.includes('res.wx.qq.com') && alt;
  },
  replacement: function (content, node) {
    return node.getAttribute('alt') || '';
  }
});

// Handle video embeds (Tencent/WeChat video iframes)
// WeChat's mpvideo iframe uses `data-src` (a readtemplate player URL) and has
// no `src` at all, so the address must be read from data-src / data-mpvid too.
turndownService.addRule('wechatVideo', {
  filter: function (node) {
    if (node.nodeName === 'IFRAME') {
      const src = node.getAttribute('src') || '';
      const dataSrc = node.getAttribute('data-src') || '';
      return src.includes('v.qq.com') || src.includes('video.weixin.qq.com') ||
        dataSrc.includes('v.qq.com') || dataSrc.includes('video.weixin.qq.com') ||
        dataSrc.includes('video_player_tmpl') || dataSrc.includes('action=mpvideo') ||
        (node.classList && node.classList.contains('video_iframe'));
    }
    if (node.nodeName === 'VIDEO') return true;
    if (node.classList && node.classList.contains('video_iframe')) return true;
    return false;
  },
  replacement: function (content, node) {
    let src = '';
    if (node.nodeName === 'IFRAME') {
      src = node.getAttribute('src') || node.getAttribute('data-src') || '';
    } else if (node.nodeName === 'VIDEO') {
      src = node.getAttribute('src') || node.getAttribute('data-src') ||
        (node.querySelector('source') && node.querySelector('source').getAttribute('src')) || '';
    }
    // Last resort: rebuild the WeChat player URL from the video id.
    if (!src) {
      const mpvid = node.getAttribute('data-mpvid') || node.getAttribute('data-vid');
      if (mpvid) {
        src = 'https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&auto=0&vid=' + encodeURIComponent(mpvid);
      }
    }
    // New saves use a Chinese label; a real title (Chinese or English) is
    // still appended, so old English titles keep working.
    const rawTitle = node.getAttribute('data-title') || node.getAttribute('title') || '';
    const label = rawTitle && rawTitle !== 'Video' ? '视频：' + rawTitle : '视频';
    if (src) {
      return '\n\n> [' + label + '](' + src + ')\n\n';
    }
    return '\n\n> [' + label + ']\n\n';
  }
});

// Handle audio/voice embeds
turndownService.addRule('wechatAudio', {
  filter: function (node) {
    if (node.nodeName === 'AUDIO') return true;
    if (node.nodeName === 'MP-VOICE') return true;
    if (node.classList && node.classList.contains('audio_area')) return true;
    return false;
  },
  replacement: function (content, node) {
    let title = 'Audio';
    if (node.nodeName === 'MP-VOICE') {
      title = node.getAttribute('title') || node.textContent.trim() || 'Voice message';
    } else if (node.nodeName === 'AUDIO') {
      title = node.getAttribute('title') || 'Audio';
    }
    const src = node.getAttribute('src') || '';
    if (src) {
      return '\n\n> [AUDIO: ' + title + '](' + src + ')\n\n';
    }
    return '\n\n> [AUDIO: ' + title + ']\n\n';
  }
});

// Handle WeChat card/product embeds
turndownService.addRule('wechatCard', {
  filter: function (node) {
    const tagName = node.nodeName;
    if (tagName === 'MP-COMMON-PRODUCT' || tagName === 'MP-COMMON-CARD' ||
        tagName === 'MP-COMMON-SHOP' || tagName === 'MP-COMMON-CPSPRODUCT') {
      return true;
    }
    if (node.classList && (node.classList.contains('card_container') || node.classList.contains('product_card'))) {
      return true;
    }
    return false;
  },
  replacement: function (content, node) {
    let title = 'Embedded content';
    const dataTitle = node.getAttribute('data-title');
    if (dataTitle) title = dataTitle;
    return '\n\n> [CARD: ' + title + ']\n\n';
  }
});

// Handle code blocks with language detection
turndownService.addRule('wechatCodeBlock', {
  filter: function (node) {
    return node.nodeName === 'PRE' &&
      (node.className.includes('prettyprint') || node.className.includes('language-') || node.className.includes('lang-'));
  },
  replacement: function (content, node) {
    let lang = '';
    const cls = node.className;
    const langMatch = cls.match(/(?:lang-|language-)(\w+)/i);
    if (langMatch) lang = langMatch[1];
    const code = node.querySelector('code');
    const text = code ? code.textContent : node.textContent;
    return '\n\n```' + lang + '\n' + text.trim() + '\n```\n\n';
  }
});

// Convert ordinary HTML tables to GFM pipe tables.
// Registered before preserveComplexTables so marked complex tables keep raw HTML.
turndownService.addRule('gfmTables', {
  filter: function (node) {
    return node.nodeName === 'TABLE';
  },
  replacement: function (content, node) {
    const rows = Array.from(node.rows || []);
    if (!rows.length) return '';

    const tableCells = rows.map(function (row) {
      return Array.from(row.cells || []);
    });
    if (!tableCells.some(function (cells) { return cells.length > 0; })) return '';

    // Merged cells cannot be expressed in GFM; leave them as raw HTML.
    const hasMergedCells = tableCells.some(function (cells) {
      return cells.some(function (cell) {
        return cell.hasAttribute &&
          (cell.hasAttribute('colspan') || cell.hasAttribute('rowspan'));
      });
    });
    if (hasMergedCells) {
      return '\n\n' + node.outerHTML + '\n\n';
    }

    const colCount = Math.max.apply(null, tableCells.map(function (cells) {
      return cells.length;
    }));
    if (colCount === 0) return '';

    function cellText(cell) {
      if (!cell) return '';
      let text = turndownService.turndown(cell.innerHTML || '').trim();
      text = text.replace(/\r/g, '').replace(/\s*\n+\s*/g, '<br>');
      text = text.replace(/\|/g, '\\|');
      return text;
    }

    function formatRow(cells) {
      const parts = [];
      for (let i = 0; i < colCount; i++) {
        parts.push(cellText(cells[i]));
      }
      return '| ' + parts.join(' | ') + ' |';
    }

    // GFM needs a header row. Prefer an existing TH row; otherwise promote the first row.
    let headerIndex = tableCells.findIndex(function (cells) {
      return cells.some(function (cell) { return cell.nodeName === 'TH'; });
    });
    if (headerIndex < 0) headerIndex = 0;

    // GFM left alignment is ':---' (not '---:', which means right alignment).
    const alignRow = '| ' + Array(colCount).fill(':---').join(' | ') + ' |';

    const lines = [formatRow(tableCells[headerIndex]), alignRow];
    tableCells.forEach(function (cells, index) {
      if (index !== headerIndex) lines.push(formatRow(cells));
    });

    return '\n\n' + lines.join('\n') + '\n\n';
  }
});

// Preserve complex tables as raw HTML
turndownService.addRule('preserveComplexTables', {
  filter: function (node) {
    return node.hasAttribute && node.hasAttribute('data-preserve-html');
  },
  replacement: function (content, node) {
    return '\n\n' + node.outerHTML + '\n\n';
  }
});

// Convert HTML to Markdown
function convertToMarkdown(html) {
  return turndownService.turndown(html);
}
