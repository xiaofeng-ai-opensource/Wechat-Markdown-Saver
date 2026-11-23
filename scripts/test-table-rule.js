'use strict';

// Logic-level test for the GFM table rule in content/turndown-config.js.
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
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
}

const sandbox = { TurndownService: TurndownServiceStub, console };
vm.runInNewContext(source, sandbox, { filename: configPath });
const turndownService = sandbox.__WMS_TEST__.turndownService;
const rule = turndownService.rules.gfmTables;

function makeCell(text, tag, attrs) {
  attrs = attrs || {};
  return {
    nodeName: tag || 'TD',
    innerHTML: text,
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getAttribute: function (name) {
      return attrs[name] || null;
    }
  };
}

function makeRow(texts, tag) {
  return {
    nodeName: 'TR',
    cells: texts.map(function (text) { return makeCell(text, tag); })
  };
}

function makeTable(rows) {
  return {
    nodeName: 'TABLE',
    rows: rows,
    outerHTML: '<table><tr><td>merged</td></tr></table>',
    hasAttribute: function () { return false; },
    getAttribute: function () { return null; }
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('规则优先级：复杂表保留规则先于 GFM 规则', function () {
  assert.strictEqual(turndownService.order[0], 'preserveComplexTables');
  assert.strictEqual(turndownService.order[1], 'gfmTables');
});

check('四列表格生成 GFM 表头、左对齐分隔行与数据行', function () {
  const header = makeRow(['对比项', 'OpenMuse', 'Meta Muse', 'AutoGen/CrewAI 传统 Agent 框架'], 'TH');
  const row1 = makeRow(['部署方式', '自托管，部署在自己服务器', 'Meta 云端托管闭源', '本地 / API 调用，无独立执行环境']);
  const row2 = makeRow(['任务持久化', '✅支持断点续跑', '✅后台长任务', '❌进程终止任务即结束']);
  const lines = rule.replacement('', makeTable([header, row1, row2])).trim().split('\n');

  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0], '| 对比项 | OpenMuse | Meta Muse | AutoGen/CrewAI 传统 Agent 框架 |');
  assert.strictEqual(lines[1], '| :--- | :--- | :--- | :--- |');
  assert.strictEqual(lines[2], '| 部署方式 | 自托管，部署在自己服务器 | Meta 云端托管闭源 | 本地 / API 调用，无独立执行环境 |');
  assert.ok(lines[3].indexOf('✅支持断点续跑') !== -1);
});

check('单元格竖线转义、换行转 br', function () {
  const header = makeRow(['A', 'B'], 'TH');
  const row = makeRow(['a | b', 'line1\nline2']);
  const output = rule.replacement('', makeTable([header, row]));

  assert.ok(output.indexOf('a \\| b') !== -1);
  assert.ok(output.indexOf('line1<br>line2') !== -1);
});

check('无 TH 的表格以首行为表头', function () {
  const lines = rule.replacement('', makeTable([
    makeRow(['a', 'b']),
    makeRow(['c', 'd'])
  ])).trim().split('\n');

  assert.strictEqual(lines[0], '| a | b |');
  assert.strictEqual(lines[1], '| :--- | :--- |');
  assert.strictEqual(lines[2], '| c | d |');
});

check('空表跳过', function () {
  assert.strictEqual(rule.replacement('', makeTable([])), '');
  assert.strictEqual(rule.replacement('', makeTable([makeRow([])])), '');
});

check('含合并单元格的表格回退为原始 HTML', function () {
  const header = makeRow(['X', 'Y'], 'TH');
  const mergedRow = { nodeName: 'TR', cells: [makeCell('span', 'TD', { colspan: '2' })] };
  const output = rule.replacement('', makeTable([header, mergedRow]));

  assert.ok(output.indexOf('<table>') !== -1);
});

console.log('\nALL TESTS PASSED (' + passed + ' checks)');
