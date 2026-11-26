'use strict';

// Logic-level test for the popup pre-check dedup path (v2.3.5).
// Loads the REAL popup.js and saved-index.js in a vm sandbox with stubbed
// DOM / chrome APIs, then calls precheckDuplicate() directly. No browser,
// no real folder, no network required.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const popupPath = path.join(ROOT, 'popup', 'popup.js');
const indexPath = path.join(ROOT, 'shared', 'saved-index.js');

// ── Stub DOM / chrome APIs ────────────────────────────────────────────

function makeEl() {
  return {
    disabled: false, value: '', textContent: '', innerHTML: '',
    className: '', placeholder: '',
    classList: { add() {}, remove() {} },
    addEventListener() {}
  };
}

const els = {};
let storageCfg = {};
let readCalls = 0;

const sandbox = {
  URL, console, setTimeout, clearTimeout,
  globalThis: {},
  document: {
    getElementById: (id) => (els[id] = els[id] || makeEl())
  },
  chrome: {
    storage: {
      local: {
        get: (keys, cb) => cb(Object.assign({}, storageCfg))
      }
    },
    tabs: { query: async () => [] },
    runtime: { connect: () => ({}) }
  },
  // Keep init callbacks dormant so popup startup does not touch the stubs.
  onI18nReady: () => {},
  // Echo key + args so assertions can verify what was passed to the UI.
  t: (key, args) => key + ':' + ((args || []).join(',')),
  applyI18n: () => {},
  __WMS_FOLDER__: {},
  __WMS_TIME__: {}
};

const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(indexPath, 'utf8'), context, { filename: indexPath });
vm.runInContext(fs.readFileSync(popupPath, 'utf8'), context, { filename: popupPath });
const S = sandbox.globalThis.__WMS_SAVED_INDEX__;

function setStateVars(folderState, handle) {
  // Assign the handle BEFORE the eval that copies it into cachedHandle.
  sandbox.globalThis.__testHandle = handle;
  vm.runInContext(
    'folderState = ' + JSON.stringify(folderState) + '; cachedHandle = globalThis.__testHandle;',
    context
  );
}

// Minimal dir handle exposing only the index file, backed by an in-memory string.
function makeIndexHandle(textOrObj) {
  const text = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj);
  return {
    getFileHandle: async (name) => {
      if (name !== S.INDEX_FILE) {
        const err = new Error('NotFound: ' + name);
        err.name = 'NotFoundError';
        throw err;
      }
      return { getFile: async () => ({ text: async () => text }) };
    }
  };
}

// Count readIndex() calls without changing its behaviour.
const realReadIndex = S.readIndex;
S.readIndex = async function (handle) { readCalls++; return realReadIndex(handle); };

const hitIndex = {
  version: S.VERSION,
  articles: {
    'https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A': {
      dirName: 'PDF神器_nwx8a69n', safeTitle: 'PDF神器', title: 'PDF神器', author: ''
    }
  }
};

let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  PASS  ' + name);
  });
}

(async function () {
  console.log('\nPopup pre-check dedup tests\n');

  await check('ready + 命中 + 未开覆盖 → 返回记录（拦截保存）', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('ready', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.ok(rec, 'expected a duplicate record');
    assert.strictEqual(rec.dirName, 'PDF神器_nwx8a69n');
    assert.strictEqual(readCalls, 1);
  });

  await check('ready + 带 query 的短链 → 规范化后仍命中', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('ready', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate(
      'https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A?scene=1#rd'
    );
    assert.ok(rec, 'query/fragment must be ignored by normalizeUrl');
    assert.strictEqual(rec.dirName, 'PDF神器_nwx8a69n');
  });

  await check('ready + 未命中 → null（放行保存）', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('ready', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/NOT_SAVED');
    assert.strictEqual(rec, null);
    assert.strictEqual(readCalls, 1);
  });

  await check('needs_auth → 跳过，且不读索引（保住授权手势）', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('needs_auth', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.strictEqual(rec, null);
    assert.strictEqual(readCalls, 0, 'must not touch the index when auth is pending');
  });

  await check('unconfigured → 跳过，且不读索引', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('unconfigured', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.strictEqual(rec, null);
    assert.strictEqual(readCalls, 0);
  });

  await check('覆盖保存开启 → 跳过，且不读索引（命中也不拦）', async function () {
    storageCfg = { overwriteExisting: true }; readCalls = 0;
    setStateVars('ready', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.strictEqual(rec, null);
    assert.strictEqual(readCalls, 0);
  });

  await check('索引损坏 → null（不阻断保存，交后端兜底）', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('ready', makeIndexHandle('{broken json'));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.strictEqual(rec, null);
  });

  await check('索引缺失 → null，且不重建索引（popup 只读）', async function () {
    storageCfg = {}; readCalls = 0;
    const missing = {
      getFileHandle: async () => {
        const err = new Error('NotFound');
        err.name = 'NotFoundError';
        throw err;
      }
    };
    setStateVars('ready', missing);
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.strictEqual(rec, null);
    const before = JSON.stringify(missing);
    assert.strictEqual(typeof missing.getFileHandle, 'function');
    assert.ok(before.length > 0);
  });

  await check('命中收尾 → already-saved 文案 + 两个保存按钮置灰', async function () {
    storageCfg = {}; readCalls = 0;
    setStateVars('ready', makeIndexHandle(hitIndex));
    const rec = await sandbox.precheckDuplicate('https://mp.weixin.qq.com/s/ryfGL2YPwcy9Yf9NMEvc8A');
    assert.ok(rec);
    sandbox.showPrecheckDuplicate(rec);
    assert.ok(els['save-btn'].disabled, 'save button must be disabled');
    assert.ok(els['url-save-btn'].disabled, 'url save button must be disabled');
    assert.ok(
      els['result'].innerHTML.indexOf('PDF神器_nwx8a69n') !== -1,
      'result must show the recorded directory name'
    );
    assert.ok(els['save-btn'].disabled === true && els['copy-btn'] !== undefined);
  });

  console.log('\nALL PRECHECK TESTS PASSED (' + passed + ' checks)\n');
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
