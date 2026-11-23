'use strict';

// Logic-level test for the wechatVideo rule in content/turndown-config.js.
// A stub TurndownService stands in for the browser DOM; browser rendering is
// verified separately by reloading the extension and saving a real article.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const configPath = path.resolve(__dirname, '..', 'content', 'turndown-config.js');
let source = fs.readFileSync(configPath, 'utf8');
source += '\n;globalThis.__WMS_TEST__ = { turndownService: turndownService };\n';

class TurndownServiceStub {
  constructor(options) {
    this.options = options;
    this.rules = {};
    this.order = [];
  }

  addRule(key, rule) {
    this.rules[key] = rule;
    this.order.unshift(key);
  }

  turndown(html) {
    return String(html);
  }
}

const sandbox = { TurndownService: TurndownServiceStub, console };
vm.runInNewContext(source, sandbox, { filename: configPath });
const turndownService = sandbox.__WMS_TEST__.turndownService;
const rule = turndownService.rules.wechatVideo;

const PLAYER = 'https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&auto=0&vid=wxv_4728853441140178947';

function makeNode(nodeName, attrs, options) {
  attrs = attrs || {};
  options = options || {};
  const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
  return {
    nodeName: nodeName,
    classList: { contains: function (name) { return classes.indexOf(name) !== -1; } },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector: function (selector) {
      if (selector === 'source' && options.sourceSrc) {
        return { getAttribute: function (name) { return name === 'src' ? options.sourceSrc : null; } };
      }
      return null;
    }
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('微信 mpvideo iframe：从 data-src 提取播放器链接，输出中文标签', function () {
  const node = makeNode('IFRAME', {
    class: 'video_iframe rich_pages wx_video_iframe',
    'data-src': PLAYER,
    'data-mpvid': 'wxv_4728853441140178947'
  });
  assert.strictEqual(rule.filter(node), true);
  const out = rule.replacement('', node);
  assert.strictEqual(out.trim(), '> [视频](' + PLAYER + ')');
  assert.ok(out.indexOf('[VIDEO:') === -1);
});

check('无 src、只有 data-mpvid 的 iframe：按 vid 重建播放器链接', function () {
  const node = makeNode('IFRAME', {
    class: 'video_iframe wx_video_iframe',
    'data-mpvid': 'wxv_abc123'
  });
  const out = rule.replacement('', node);
  assert.strictEqual(out.trim(), '> [视频](https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&auto=0&vid=wxv_abc123)');
});

check('腾讯视频 iframe：src 仍优先于 data-src，英文标题保留', function () {
  const node = makeNode('IFRAME', {
    src: 'https://v.qq.com/txp/iframe/player.html?vid=abc',
    'data-src': PLAYER,
    title: 'Intro'
  });
  assert.strictEqual(rule.filter(node), true);
  assert.strictEqual(rule.replacement('', node).trim(), '> [视频：Intro](https://v.qq.com/txp/iframe/player.html?vid=abc)');
});

check('VIDEO 元素：src 与嵌套 source 均可提取', function () {
  const withSrc = makeNode('VIDEO', { src: 'https://example.com/a.mp4' });
  assert.strictEqual(rule.filter(withSrc), true);
  assert.strictEqual(rule.replacement('', withSrc).trim(), '> [视频](https://example.com/a.mp4)');

  const withSource = makeNode('VIDEO', {}, { sourceSrc: 'https://example.com/b.mp4' });
  assert.strictEqual(rule.replacement('', withSource).trim(), '> [视频](https://example.com/b.mp4)');
});

check('任意 video_iframe 类节点：仍能识别', function () {
  const node = makeNode('DIV', { class: 'foo video_iframe bar' });
  assert.strictEqual(rule.filter(node), true);
});

check('无关 iframe：不误伤', function () {
  const node = makeNode('IFRAME', { src: 'https://example.com/embed' });
  assert.strictEqual(rule.filter(node), false);
});

check('无地址时：输出无链接的中文占位，不再出现假标题 Video', function () {
  const node = makeNode('VIDEO', {});
  const out = rule.replacement('', node);
  assert.strictEqual(out.trim(), '> [视频]');
  assert.ok(out.indexOf('Video') === -1);
});

check('中文 data-title 保留', function () {
  const node = makeNode('IFRAME', { 'data-src': PLAYER, 'data-title': '三次握手演示' });
  assert.strictEqual(rule.replacement('', node).trim(), '> [视频：三次握手演示](' + PLAYER + ')');
});

console.log('\nALL TESTS PASSED (' + passed + ' checks)');
