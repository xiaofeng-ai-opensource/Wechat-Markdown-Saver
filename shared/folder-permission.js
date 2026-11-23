// shared/folder-permission.js — Unified folder handle + permission helpers.
// Loaded in popup, options, the service worker and the offscreen document,
// so every layer shares one implementation of handle reading and permission
// checks. Functions that touch chrome.storage.local (getFolderState /
// restoreMark) are meant for UI pages only; the offscreen document never
// calls them.

(function () {
  const DB_NAME = 'wechat-md-saver';
  const DB_VERSION = 1;
  const STORE_NAME = 'handles';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Read the stored FileSystemDirectoryHandle. Retries briefly because the
  // first open right after browser start can race with other pages.
  async function readHandle() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const db = await openDB();
        const handle = await new Promise((resolve) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get('dirHandle');
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
        if (handle) return handle;
      } catch (e) { /* retry below */ }
      if (attempt < 2) await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  // 'granted' | 'prompt' | 'denied' | 'no_handle' | 'error'
  async function queryPermission(handle) {
    if (!handle) return 'no_handle';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'error';
    }
  }

  // Must be called from a real user gesture (popup / options click).
  // 'granted' | 'prompt' | 'denied' | 'no_handle' | 'error'
  async function requestPermission(handle) {
    if (!handle) return 'no_handle';
    try {
      return await handle.requestPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'error';
    }
  }

  // UI pages only. Combines the display marker, the stored handle and the
  // live permission into one of three states:
  //   'unconfigured' | 'needs_auth' | 'ready'
  async function getFolderState() {
    const stored = await chrome.storage.local.get(['folderName', 'folderSet']);
    const handle = await readHandle();
    if (!stored.folderSet || !handle) {
      return { state: 'unconfigured', name: null, handle: null, permission: null };
    }
    const perm = await queryPermission(handle);
    return {
      state: perm === 'granted' ? 'ready' : 'needs_auth',
      name: stored.folderName || handle.name,
      handle: handle,
      permission: perm
    };
  }

  // D7: an old failure path deleted only the display marker while the handle
  // survived. Restore the marker on startup so the UI shows the truth again.
  async function restoreMark() {
    try {
      const handle = await readHandle();
      if (!handle) return false;
      const stored = await chrome.storage.local.get(['folderName', 'folderSet']);
      if (stored.folderSet && stored.folderName) return false;
      await chrome.storage.local.set({ folderName: handle.name, folderSet: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  globalThis.__WMS_FOLDER__ = {
    openDB,
    readHandle,
    queryPermission,
    requestPermission,
    getFolderState,
    restoreMark
  };
})();
