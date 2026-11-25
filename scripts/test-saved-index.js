'use strict';

// Logic-level test for shared/saved-index.js. Uses an in-memory stub of
// FileSystemDirectoryHandle so no real folder or browser is required.
// Browser-level behaviour (permissions, real writes) is verified separately
// by loading the extension and saving a real article.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const modulePath = path.resolve(__dirname, '..', 'shared', 'saved-index.js');
const sandbox = { URL: URL, console: console, globalThis: {} };
vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
const S = sandbox.globalThis.__WMS_SAVED_INDEX__;

// ── Minimal in-memory directory handle ────────────────────────────────

// Keys in `initial` are "<dir>/<file>" for article directories, or a plain
// name for files at the root (e.g. the index file).
function makeDirHandleWithWrite(initial) {
  const store = Object.assign({}, initial || {});
  const dirNames = [...new Set(Object.keys(store)
    .filter(k => k.indexOf('/') !== -1)
    .map(k => k.split('/')[0]))];

  function fileHandle(fullKey, baseName) {
    return {
      kind: 'file',
      name: baseName,
      getFile: async () => ({ text: async () => store[fullKey] }),
      createWritable: async () => ({
        write: async (content) => { store[fullKey] = String(content); },
        close: async () => {}
      })
    };
  }

  function subDirHandle(dirName) {
    const prefix = dirName + '/';
    return {
      kind: 'directory',
      name: dirName,
      entries: async function* () {
        for (const k of Object.keys(store)) {
          if (k.indexOf(prefix) === 0) yield [k.slice(prefix.length), fileHandle(k, k.slice(prefix.length))];
        }
      },
      getFileHandle: async (name, opts) => {
        const fullKey = prefix + name;
        if (fullKey in store) return fileHandle(fullKey, name);
        if (opts && opts.create) {
          store[fullKey] = '';
          return fileHandle(fullKey, name);
        }
        const err = new Error('NotFound: ' + name);
        err.name = 'NotFoundError';
        throw err;
      }
    };
  }

  return {
    kind: 'directory',
    _store: store,
    entries: async function* () {
      for (const name of dirNames) yield [name, subDirHandle(name)];
      for (const name of Object.keys(store)) {
        if (name.indexOf('/') === -1) yield [name, fileHandle(name, name)];
      }
    },
    getFileHandle: async (name, opts) => {
      if (name in store) return fileHandle(name, name);
      if (opts && opts.create) {
        store[name] = '';
        return fileHandle(name, name);
      }
      const err = new Error('NotFound: ' + name);
      err.name = 'NotFoundError';
      throw err;
    }
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── Tests ─────────────────────────────────────────────────────────────

check('链接规范化：追踪参数与哈希被去掉', function () {
  const a = 'https://mp.weixin.qq.com/s/AbC123?__biz=MzA&mid=123&sn=xyz';
  const b = 'https://mp.weixin.qq.com/s/AbC123';
  assert.strictEqual(S.normalizeUrl(a), 'https://mp.weixin.qq.com/s/AbC123');
  assert.strictEqual(S.normalizeUrl(a), S.normalizeUrl(b));
});

check('链接规范化：大小写主机与结尾斜杠归一', function () {
  assert.strictEqual(
    S.normalizeUrl('HTTPS://MP.WEIXIN.QQ.COM/s/XXXX/'),
    'https://mp.weixin.qq.com/s/XXXX'
  );
});

check('链接规范化：非法输入回退为去参数的字符串', function () {
  assert.strictEqual(S.normalizeUrl('  not-a-url?x=1  '), 'not-a-url');
  assert.strictEqual(S.normalizeUrl(''), '');
});

check('frontmatter 字段只从开头块提取', function () {
  const md = [
    '---',
    'title: "测试标题"',
    'source: https://mp.weixin.qq.com/s/REAL',
    '---',
    'intro source: not-a-field',
    'source: https://mp.weixin.qq.com/s/FAKE'
  ].join('\n');
  assert.strictEqual(S.extractFrontmatterField(md, 'source'), 'https://mp.weixin.qq.com/s/REAL');
  assert.strictEqual(S.extractFrontmatterField(md, 'title'), '测试标题');
  assert.strictEqual(S.extractFrontmatterField('no frontmatter\nsource: x', 'source'), null);
});

(async function run() {
  await checkAsync('首次使用：从已有文章目录补录，只收有 source 的', async function () {
    const dir = makeDirHandleWithWrite({
      'A_abc123/article.md': '---\ntitle: "A"\nsource: https://mp.weixin.qq.com/s/AAA\n---\nbody',
      'B_def456/article.md': '---\ntitle: "B"\nsource: https://mp.weixin.qq.com/s/BBB\n---\nbody',
      'C_ghi789/article.md': '---\ntitle: "C"\n---\nbody',
      'notes.txt': 'unrelated'
    });
    const built = await S.buildIndexFromDirectory(dir);
    assert.strictEqual(Object.keys(built.articles).length, 2);
    assert.ok(S.lookup(built, 'https://mp.weixin.qq.com/s/AAA?from=share'));
    assert.strictEqual(S.lookup(built, 'https://mp.weixin.qq.com/s/CCC'), null);
  });

  await checkAsync('清单读写：ensureIndex 首次建清单，二次读回', async function () {
    const dir = makeDirHandleWithWrite({
      'A_abc123/article.md': '---\ntitle: "A"\nsource: https://mp.weixin.qq.com/s/AAA\n---\nbody'
    });
    const first = await S.ensureIndex(dir);
    assert.strictEqual(Object.keys(first.articles).length, 1);
    assert.ok(S.INDEX_FILE in dir._store);
    // Change the underlying article; the second read must return the index,
    // not rescan the folder.
    dir._store['NEW_xyz/article.md'] = '---\nsource: https://mp.weixin.qq.com/s/NEW\n---\nbody';
    const second = await S.ensureIndex(dir);
    assert.strictEqual(S.lookup(second, 'https://mp.weixin.qq.com/s/NEW'), null);
  });

  await checkAsync('记录只在调用 upsert 后出现', async function () {
    const dir = makeDirHandleWithWrite({});
    const index = await S.ensureIndex(dir);
    assert.strictEqual(S.lookup(index, 'https://mp.weixin.qq.com/s/NEW'), null);
    S.upsert(index, 'https://mp.weixin.qq.com/s/NEW?from=app', {
      dirName: 'NEW_xyz', safeTitle: 'NEW', title: '新文章', savedAt: '2026-11-25T00:00:00+08:00'
    });
    await S.writeIndex(dir, index);
    const reloaded = await S.readIndex(dir);
    const rec = S.lookup(reloaded, 'https://mp.weixin.qq.com/s/NEW');
    assert.ok(rec);
    assert.strictEqual(rec.dirName, 'NEW_xyz');
    assert.strictEqual(rec.safeTitle, 'NEW');
  });

  await checkAsync('清单损坏时按不存在处理，不影响保存', async function () {
    const dir = makeDirHandleWithWrite({ [S.INDEX_FILE]: '{broken json' });
    assert.strictEqual(await S.readIndex(dir), null);
  });

  console.log('\nALL TESTS PASSED (' + passed + ' checks)');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
