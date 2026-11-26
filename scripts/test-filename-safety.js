'use strict';

// Logic-level regression test for shared/filename.js.
// It mirrors the File System Access checks that caused v2.3.2's
// "Name is not allowed" failure for titles ending in "...".

const assert = require('assert');
const path = require('path');

require(path.resolve(__dirname, '..', 'shared', 'filename.js'));
const sanitize = globalThis.__WMS_FILENAME__.sanitize;

const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const DANGEROUS = /\.(?:lnk|scf|url|exe|msi|msp|bat|cmd|scr|pif|cpl|hta|jse|vbe|vbs|js|wsf|wsh|ps1|jar|appref-ms)$/i;

function assertFileSystemNameSafe(name, label) {
  assert.ok(name, label + ': empty name');
  assert.ok(name !== '.' && name !== '..', label + ': current/parent directory name');
  assert.ok(!/[/\\]/.test(name), label + ': path separator');
  assert.ok(!/["*:<>?|]/.test(name), label + ': illegal character');
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(name), label + ': control/format character');
  assert.ok(!/[.~\s]$/u.test(name), label + ': illegal trailing character');
  assert.ok(!RESERVED.test(name), label + ': Windows reserved name');
  assert.ok(!DANGEROUS.test(name), label + ': dangerous extension');
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('标题以省略号结尾时去掉结尾点', function () {
  const safe = sanitize('理解AI核心基本概念:Prompt、Function Call、MCP、A2A...');
  assert.strictEqual(safe, '理解AI核心基本概念-Prompt、Function_Call、MCP、A2A');
  assertFileSystemNameSafe(safe, '省略号标题');
  assertFileSystemNameSafe(safe + '_m' + Date.now().toString(36), '文章目录名');
});

check('非法字符与零宽字符被清理', function () {
  const safe = sanitize('a/b\\c:d*e?f"g<h>i|j\u200Bk');
  assert.strictEqual(safe, 'a-b-c-d-e-f-g-h-i-jk');
  assertFileSystemNameSafe(safe, '非法字符标题');
});

check('结尾空格与波浪号被清理', function () {
  const safe = sanitize('  tail ~  ');
  assert.strictEqual(safe, 'tail_');
  assertFileSystemNameSafe(safe, '结尾噪声标题');
});

check('Windows 保留名被加后缀', function () {
  const safe = sanitize('CON');
  assert.strictEqual(safe, 'CON_');
  assertFileSystemNameSafe(safe, '保留名标题');
});

check('危险扩展名被中和', function () {
  const safe = sanitize('note.url');
  assert.strictEqual(safe, 'note.url_');
  assertFileSystemNameSafe(safe, '危险扩展名标题');
});

check('空标题回退为默认名称', function () {
  assert.strictEqual(sanitize(''), 'wechat-article');
  assert.strictEqual(sanitize('....'), 'wechat-article');
});

check('截断按码点进行且截断后仍安全', function () {
  const safe = sanitize('A'.repeat(99) + '...B', 100);
  assert.strictEqual(safe, 'A'.repeat(99));
  assertFileSystemNameSafe(safe, '截断标题');
});

console.log('\nALL TESTS PASSED (' + passed + ' checks)');
