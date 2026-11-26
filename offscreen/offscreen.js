// offscreen.js — Persistent page context for file system operations.
// Chrome MV3 service workers lose FileSystemDirectoryHandle permissions
// after restart. This offscreen document stays alive and holds the handle
// in a proper DOM context where permissions survive.
//
// This document only QUERIES permission and writes files. It never calls
// requestPermission() (no user gesture here) and never touches
// chrome.storage.local (restricted in offscreen contexts). When permission
// is not 'granted' it returns a structured code so a UI page can re-authorize.

const F = globalThis.__WMS_FOLDER__;

let _dirHandle = null;
let _keepAliveTimer = null;

// Read the stored handle without checking or requesting permission.
async function loadDirectoryHandle() {
  if (_dirHandle) return _dirHandle;
  const handle = await F.readHandle();
  if (handle) _dirHandle = handle;
  return handle;
}

async function verifyPermission(handle) {
  return F.queryPermission(handle);
}

// Reload handle from IndexedDB (called when options page updates it).
// The folder name comes from the handle itself, not from storage.
async function reloadHandle() {
  _dirHandle = null;
  const handle = await loadDirectoryHandle();
  if (handle) return { usable: true, name: handle.name };
  return { usable: false, name: null };
}

// ── Image Downloader ───────────────────────────────────────────────────

async function downloadAllImages(images, onProgress) {
  const results = [];
  let completed = 0;

  const worker = async () => {
    while (completed < images.length) {
      const idx = completed++;
      const img = images[idx];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const resp = await fetch(img.url, { signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const buffer = await resp.arrayBuffer();
          results[idx] = {
            filename: img.filename,
            data: new Uint8Array(buffer),
            originalUrl: img.url
          };
          break;
        } catch (e) {
          if (attempt === 1) {
            results[idx] = {
              filename: img.filename,
              data: null,
              originalUrl: img.url,
              error: e.message
            };
          }
        }
      }
      if (onProgress) {
        onProgress(results.filter(r => r !== undefined).length, images.length);
      }
    }
  };

  const concurrency = Math.min(3, images.length || 1);
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── File Writing ───────────────────────────────────────────────────────

async function writeArticle(dirHandle, payload, sendProgress) {
  const { safeDirName, safeTitle, markdown, images, outputStructure } = payload;

  // Download images
  sendProgress('swDownloading', [String(images.length)]);
  const imageResults = await downloadAllImages(images, (done, total) => {
    sendProgress('swDownloadingProgress', [String(done), String(total)]);
  });
  const succeeded = imageResults.filter(r => r.data !== null);

  sendProgress('swWriting');

  const articleDir = await dirHandle.getDirectoryHandle(safeDirName, { create: true });

  let imagesDir;
  if (outputStructure === 'obsidian') {
    const assetsDir = await articleDir.getDirectoryHandle('assets', { create: true });
    imagesDir = await assetsDir.getDirectoryHandle(safeTitle, { create: true });
  } else {
    imagesDir = await articleDir.getDirectoryHandle('images', { create: true });
  }

  // Write markdown
  const mdFileName = outputStructure === 'obsidian' ? safeTitle + '.md' : 'article.md';
  const mdFile = await articleDir.getFileHandle(mdFileName, { create: true });
  const mdWritable = await mdFile.createWritable();
  await mdWritable.write(markdown);
  await mdWritable.close();

  // Write images
  for (const r of succeeded) {
    const imgFile = await imagesDir.getFileHandle(r.filename, { create: true });
    const imgWritable = await imgFile.createWritable();
    await imgWritable.write(r.data);
    await imgWritable.close();
  }

  return {
    success: true,
    imageCount: succeeded.length,
    imageErrors: imageResults.length - succeeded.length
  };
}

// ── Message Handler ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === 'WRITE_ARTICLE') {
    handleWriteArticle(msg.payload, sender).then(sendResponse);
    return true; // async response
  }

  if (msg.action === 'RELOAD_HANDLE') {
    reloadHandle().then(sendResponse);
    return true;
  }

  if (msg.action === 'CHECK_HANDLE') {
    (async () => {
      const handle = await loadDirectoryHandle();
      if (!handle) {
        sendResponse({ usable: false, name: null, reason: 'not_found' });
        return;
      }
      const perm = await verifyPermission(handle);
      sendResponse({ usable: perm === 'granted', name: handle.name, permission: perm });
    })();
    return true;
  }

  if (msg.action === 'WRITE_PDF') {
    handleWritePdf(msg.payload).then(sendResponse);
    return true;
  }

  if (msg.action === 'PING') {
    sendResponse({ pong: true });
    return false;
  }
});

async function handleWriteArticle(payload, sender) {
  // No handle configured at all.
  const dirHandle = await loadDirectoryHandle();
  if (!dirHandle) {
    return { success: false, code: 'NO_HANDLE', message: 'No folder configured' };
  }

  // Permission must be granted here. requestPermission() cannot be called in
  // this context (no user gesture) — return a code so a UI page can fix it.
  // The display marker is NEVER cleared on failure (config survives errors).
  const perm = await verifyPermission(dirHandle);
  if (perm !== 'granted') {
    const code = perm === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_EXPIRED';
    return { success: false, code, message: 'Folder write permission not granted (' + perm + ')' };
  }

  const sendProgress = (msgKey, args) => {
    chrome.runtime.sendMessage({
      action: 'WRITE_PROGRESS',
      payload: { key: msgKey, args: args || [] }
    }).catch(() => {});
  };

  // ── Duplicate check (before any image download) ────────────────
  // The index lives in the target folder and is only written after a
  // successful save. `ensureIndex` backfills from existing article
  // directories on first use, so articles saved by older versions count.
  const S = globalThis.__WMS_SAVED_INDEX__;
  let index = null;
  let duplicate = null;
  let indexWarning = false;
  if (S && payload.sourceUrl) {
    try {
      sendProgress('swCheckingDuplicate');
      index = await S.ensureIndex(dirHandle);
      duplicate = S.lookup(index, payload.sourceUrl);
    } catch (e) {
      // A broken index must never block saving — degrade to "not tracked",
      // but report it so the user knows dedup silently stopped working.
      console.warn('Offscreen: saved-index unavailable:', e);
      indexWarning = true;
      index = null;
      duplicate = null;
    }
  }

  if (duplicate && !payload.overwriteExisting) {
    return {
      duplicate: true,
      dirName: duplicate.dirName || null,
      title: duplicate.title || null,
      indexWarning: indexWarning
    };
  }

  // Overwrite reuses ONLY the recorded directory name. The Markdown content
  // and image relative paths were built from the CURRENT output structure and
  // title, so reusing an older structure/title here would break image links.
  // Per decision: other files already in the directory are left untouched.
  let writePayload = payload;
  if (duplicate && payload.overwriteExisting && duplicate.dirName) {
    writePayload = Object.assign({}, payload, { safeDirName: duplicate.dirName });
  }

  try {
    const result = await writeArticle(dirHandle, writePayload, sendProgress);
    // Record only after the files are actually written.
    if (index && payload.sourceUrl) {
      try {
        S.upsert(index, payload.sourceUrl, {
          dirName: writePayload.safeDirName,
          safeTitle: writePayload.safeTitle,
          title: payload.title || '',
          savedAt: payload.savedAt || null,
          outputStructure: writePayload.outputStructure
        }, payload.markdown);
        await S.writeIndex(dirHandle, index);
      } catch (e) {
        console.warn('Offscreen: could not update saved-index:', e);
        indexWarning = true;
      }
    }
    return { success: true, ...result, dirName: writePayload.safeDirName, indexWarning: indexWarning };
  } catch (e) {
    console.error('Offscreen: write failed:', e);
    return { success: false, code: 'WRITE_FAILED', message: e.message || 'Failed to write files' };
  }
}

async function handleWritePdf(payload) {
  const { filename, data: pdfBase64 } = payload;
  const dirHandle = await loadDirectoryHandle();

  if (!dirHandle) {
    return { success: false, code: 'NO_HANDLE', message: 'No folder configured' };
  }

  const perm = await verifyPermission(dirHandle);
  if (perm !== 'granted') {
    return { success: false, code: perm === 'denied' ? 'PERMISSION_DENIED' : 'PERMISSION_EXPIRED' };
  }

  try {
    const binaryStr = atob(pdfBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const pdfFile = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await pdfFile.createWritable();
    await writable.write(bytes);
    await writable.close();
    return { success: true };
  } catch (e) {
    console.error('Offscreen: PDF write failed:', e);
    return { success: false, code: 'WRITE_FAILED', message: e.message };
  }
}

// ── Keep-Alive ─────────────────────────────────────────────────────────
//
// Chrome may close offscreen documents after a period of inactivity.
// A periodic self-ping helps keep this document alive.

function startKeepAlive() {
  // Send a heartbeat every 4 minutes to prevent the offscreen document
  // from being garbage-collected by Chrome.
  _keepAliveTimer = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'OFFSCREEN_HEARTBEAT' }).catch(() => {});
  }, 4 * 60 * 1000);
}

// ── Init ───────────────────────────────────────────────────────────────

(async () => {
  // Load handle on startup; name comes from the handle itself.
  const handle = await loadDirectoryHandle();
  if (handle) {
    console.log('Offscreen: loaded handle for folder:', handle.name);
  } else {
    console.log('Offscreen: no folder handle available');
  }
  startKeepAlive();
  // Tell the service worker we're ready
  chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' }).catch(() => {});
})();
