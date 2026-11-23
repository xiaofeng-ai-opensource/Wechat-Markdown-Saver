// popup.js — Extension popup UI

const saveBtn = document.getElementById('save-btn');
const copyBtn = document.getElementById('copy-btn');
const pdfBtn = document.getElementById('pdf-btn');
const statusText = document.getElementById('status-text');
const spinner = document.getElementById('spinner');
const resultDiv = document.getElementById('result');
const settingsLink = document.getElementById('settings-link');
const urlInput = document.getElementById('url-input');
const urlSaveBtn = document.getElementById('url-save-btn');
const folderNameEl = document.getElementById('folder-name');
const changeFolderLink = document.getElementById('change-folder-link');

let port = null;

// v2.3.0: handle is pre-read at popup open so the click handler can
// request permission in the same user gesture (async DB reads after the
// click would consume the gesture). See shared/folder-permission.js.
let cachedHandle = null;
let folderState = 'unconfigured'; // unconfigured | needs_auth | ready
let folderName = null;

// Apply i18n and placeholders once ready
onI18nReady(() => {
  applyI18n();
  // Placeholder for URL input
  urlInput.placeholder = t('popupUrlPlaceholder');
});

function disableAll() {
  saveBtn.disabled = true;
  copyBtn.disabled = true;
  pdfBtn.disabled = true;
  urlSaveBtn.disabled = true;
}

function enableAll() {
  saveBtn.disabled = false;
  copyBtn.disabled = false;
  pdfBtn.disabled = false;
  urlSaveBtn.disabled = !urlInput.value.trim();
}

function setState(state, data) {
  statusText.className = 'status-text';
  spinner.classList.remove('active');
  resultDiv.className = 'result';
  enableAll();

  switch (state) {
    case 'idle':
      statusText.textContent = t('popupReady');
      statusText.classList.add('idle');
      break;
    case 'working':
      statusText.textContent = data || t('popupWorking');
      statusText.classList.add('working');
      spinner.classList.add('active');
      disableAll();
      break;
    case 'success':
      statusText.textContent = t('popupDone');
      statusText.classList.add('success');
      resultDiv.className = 'result visible success';
      resultDiv.innerHTML = '<span class="result-icon">&#10003;</span> ' + data;
      break;
    case 'error':
      statusText.textContent = t('popupFailed');
      statusText.classList.add('error');
      resultDiv.className = 'result visible error';
      resultDiv.innerHTML = '<span class="result-icon">&#10007;</span> ' + data;
      break;
    case 'degraded':
      // A write failed; a zip was downloaded instead. Never show "Done!".
      statusText.textContent = t('popupDegraded');
      statusText.classList.add('error');
      resultDiv.className = 'result visible degraded';
      resultDiv.innerHTML = '<span class="result-icon">&#9888;</span> ' + data
        + '<button class="result-action" data-result-action="1">' + t('popupResultAction') + '</button>';
      break;
    case 'needs-auth':
      // v2.3.0 UI fix: the status line must mirror the folder state instead
      // of staying on the static "Ready" text from popup.html.
      statusText.textContent = t('popupFolderNeedsAuth');
      statusText.classList.add('needs-auth');
      break;
    case 'unconfigured':
      statusText.textContent = t('popupFolderNoSet');
      statusText.classList.add('idle');
      break;
    case 'not-article':
      statusText.textContent = t('popupNotArticle');
      statusText.classList.add('error');
      disableAll();
      resultDiv.className = 'result visible error';
      resultDiv.innerHTML = '<span class="result-icon">&#10007;</span> ' + t('popupNotArticleMsg');
      break;
  }
}

// --- Current page actions ---

function triggerAction(actionType) {
  if (actionType === 'COPY') {
    handleCopy();
    return;
  }
  if (actionType === 'PDF') {
    handlePdf();
    return;
  }
  // SAVE — re-authorize in this click if needed (real user gesture), then
  // proceed with the normal background write. The folder is never re-picked.
  startSave(null);
}

// Ensure write permission before a folder write. Uses the handle pre-read
// at popup open, so the requestPermission() call stays inside the click's
// user gesture. Returns true when safe to write, false when we must stop.
async function ensureWritePermission() {
  if (!cachedHandle) return true; // no folder configured: let backend degrade to zip
  const perm = await __WMS_FOLDER__.queryPermission(cachedHandle);
  if (perm === 'granted') return true;
  if (perm === 'denied') {
    folderState = 'needs_auth';
    renderFolderStatus();
    setState('error', t('popupAuthDeniedHint'));
    return false;
  }
  // 'prompt' or 'error': ask once, inside this click gesture.
  const result = await __WMS_FOLDER__.requestPermission(cachedHandle);
  if (result === 'granted') {
    folderState = 'ready';
    renderFolderStatus();
    return true;
  }
  folderState = 'needs_auth';
  renderFolderStatus();
  setState('error', t('popupAuthFailedHint'));
  return false;
}

async function startSave(tabId) {
  if (folderState !== 'unconfigured' && !(await ensureWritePermission())) return;

  setState('working', t('popupSaveToFolder'));
  port = chrome.runtime.connect({ name: 'save-article' });
  port.onMessage.addListener((msg) => {
    if (msg.status) setState('working', msg.status);
    if (msg.done) {
      const details = msg.imageErrors
        ? t('popupSavedWithErrors', [msg.filename, String(msg.imageCount), String(msg.imageErrors)])
        : t('popupSaved', [msg.filename, String(msg.imageCount)]);
      setState('success', details);
      port.disconnect();
    }
    if (msg.error) { setState('error', msg.error); port.disconnect(); }
    // v2.3.0: folder write failed -> one combined degraded result (reason +
    // next action + the zip that was downloaded instead). Never "done".
    if (msg.degraded) {
      pendingDegraded = msg;
      const details = t('popupNotWritten', [msg.reason, msg.next])
        + ' ' + t('popupZipDowngraded', [msg.filename, String(msg.imageCount)]);
      setState('degraded', details);
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    if (saveBtn.disabled && !resultDiv.className.includes('visible')) {
      setState('error', t('popupConnectionLost'));
    }
  });
  port.postMessage(tabId ? { action: 'SAVE_ARTICLE', tabId } : { action: 'SAVE_ARTICLE' });
}

// Holds the last degraded result so the result-area action button can react.
let pendingDegraded = null;

function handleDegradedAction() {
  const code = pendingDegraded && pendingDegraded.code;
  const reauthorizable = ['PERMISSION_EXPIRED', 'PERMISSION_DENIED'].includes(code);
  (async () => {
    if (reauthorizable && cachedHandle) {
      // D11=③: re-authorize only when permission failed, in this click.
      const result = await __WMS_FOLDER__.requestPermission(cachedHandle);
      if (result === 'granted') {
        folderState = 'ready';
        renderFolderStatus();
        pendingDegraded = null;
        startSave(null);
      } else {
        chrome.runtime.openOptionsPage();
      }
      return;
    }
    if (code === 'NO_HANDLE') {
      chrome.runtime.openOptionsPage();
      return;
    }
    // WRITE_FAILED / COMMUNICATION_ERROR / OFFSCREEN_UNAVAILABLE: retry (D12=①).
    pendingDegraded = null;
    startSave(null);
  })();
}

async function handleCopy() {
  setState('working', t('popupCopyingToClipboard'));
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('mp.weixin.qq.com/s/')) {
      setState('not-article'); return;
    }
    const extractResult = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT' });
    if (!extractResult || !extractResult.success) {
      setState('error', extractResult?.error || t('swExtractionFailed')); return;
    }
    const { title, author, publishDate, markdown, sourceUrl } = extractResult.payload;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const frontmatter = [
      '---', 'title: "' + esc(title) + '"', 'author: "' + esc(author) + '"',
      'date: "' + esc(publishDate) + '"', 'source: ' + sourceUrl, 'saved_at: ' + now,
      '---', '', ''
    ].join('\n');
    await chrome.tabs.sendMessage(tab.id, { action: 'COPY_TO_CLIPBOARD', text: frontmatter + markdown });
    setState('success', t('popupCopied'));
  } catch (err) {
    setState('error', err.message || t('popupCopyFailed'));
  }
}

function handlePdf() {
  setState('working', t('popupSavingPdf'));
  port = chrome.runtime.connect({ name: 'save-article' });
  port.onMessage.addListener((msg) => {
    if (msg.status) setState('working', msg.status);
    if (msg.done) {
      if (msg.pdf) {
        setState('success', t('popupPdfSaved', [msg.filename]));
      }
      port.disconnect();
    }
    if (msg.error) { setState('error', msg.error); port.disconnect(); }
  });
  port.onDisconnect.addListener(() => {
    if (pdfBtn.disabled && !resultDiv.className.includes('visible')) {
      setState('error', t('popupConnectionLost'));
    }
  });
  port.postMessage({ action: 'SAVE_PDF' });
}

saveBtn.addEventListener('click', () => triggerAction('SAVE'));
copyBtn.addEventListener('click', () => triggerAction('COPY'));
pdfBtn.addEventListener('click', () => triggerAction('PDF'));

// --- URL input ---

urlInput.addEventListener('input', () => {
  const val = urlInput.value.trim();
  urlSaveBtn.disabled = !val || !val.includes('mp.weixin.qq.com/s/');
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !urlSaveBtn.disabled) urlSaveBtn.click();
});

urlSaveBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url || !url.includes('mp.weixin.qq.com/s/')) return;
  setState('working', t('swOpeningArticle'));
  urlSaveBtn.disabled = true;

  try {
    const tab = await chrome.tabs.create({ url: url, active: false });
    await new Promise((resolve, reject) => {
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error(t('swPageLoadTimeout'))); }, 30000);
    });
    await new Promise(r => setTimeout(r, 2000));

    const extractResult = await chrome.tabs.sendMessage(tab.id, { action: 'EXTRACT' });
    if (!extractResult || !extractResult.success) {
      await chrome.tabs.remove(tab.id);
      setState('error', extractResult?.error || 'Extraction failed'); return;
    }

    // Reuse the same save path (incl. pre-auth and degraded handling).
    // The tab is extracted in the background via tabId; close it on any
    // terminal message so the temporary tab never leaks.
    port = chrome.runtime.connect({ name: 'save-article' });
    port.onMessage.addListener(async (msg) => {
      if (msg.status) setState('working', msg.status);
      if (msg.done || msg.error || msg.degraded) {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }
      if (msg.done) {
        const details = msg.imageErrors
          ? t('popupSavedWithErrors', [msg.filename, String(msg.imageCount), String(msg.imageErrors)])
          : t('popupSaved', [msg.filename, String(msg.imageCount)]);
        setState('success', details);
        port.disconnect();
        urlInput.value = ''; urlSaveBtn.disabled = true;
      }
      if (msg.error) { setState('error', msg.error); port.disconnect(); }
      if (msg.degraded) {
        pendingDegraded = msg;
        const details = t('popupNotWritten', [msg.reason, msg.next])
          + ' ' + t('popupZipDowngraded', [msg.filename, String(msg.imageCount)]);
        setState('degraded', details);
        port.disconnect();
        urlInput.value = ''; urlSaveBtn.disabled = true;
      }
    });
    port.onDisconnect.addListener(async () => {
      if (urlSaveBtn.disabled && !resultDiv.className.includes('visible')) {
        setState('error', t('popupConnectionLost'));
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }
    });
    // Pre-authorize in this click using the cached handle, same as the
    // current-page save path.
    if (folderState !== 'unconfigured' && !(await ensureWritePermission())) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return;
    }
    port.postMessage({ action: 'SAVE_ARTICLE', tabId: tab.id });
  } catch (err) {
    setState('error', err.message || 'Failed to save URL');
  }
});

// --- Links ---

changeFolderLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
settingsLink.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

// Result-area action button (retry / re-authorize / open settings).
// Bound once via delegation so it survives innerHTML updates in setState().
resultDiv.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-result-action]');
  if (btn) handleDegradedAction();
});

// --- Folder status (three states) ---

function renderFolderStatus() {
  folderNameEl.className = '';
  if (folderState === 'ready') {
    folderNameEl.textContent = folderName || t('popupFolderNoSet');
    folderNameEl.classList.add('set');
  } else if (folderState === 'needs_auth') {
    folderNameEl.textContent = (folderName || t('popupFolderNoSet')) + ' · ' + t('popupFolderNeedsAuth');
    folderNameEl.classList.add('needs-auth');
  } else {
    folderNameEl.textContent = t('popupFolderNoSet');
  }
}

// --- Init ---

onI18nReady(async () => {
  // D7: heal an old wrongly-cleared marker before rendering state.
  await __WMS_FOLDER__.restoreMark();
  const state = await __WMS_FOLDER__.getFolderState();
  cachedHandle = state.handle;
  folderName = state.name;
  folderState = state.state;
  renderFolderStatus();
  // Sync the status line with the folder state (an article page would
  // otherwise keep the static "Ready" text from popup.html).
  if (folderState === 'needs_auth') setState('needs-auth');
  else if (folderState === 'unconfigured') setState('unconfigured');
  else setState('idle');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('mp.weixin.qq.com/s/')) {
      setState('not-article');
    }
  } catch (e) {}
});
