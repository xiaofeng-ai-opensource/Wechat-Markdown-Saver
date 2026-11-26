// options.js — Settings page: folder, mode, structure, language

const F = globalThis.__WMS_FOLDER__;

// DB handles are owned by the shared module now; options.js keeps a local
// connection only for the write performed when the user picks a folder.

onI18nReady(() => { applyI18n(); });

// --- IndexedDB ---

async function storeDirectoryHandle(handle) {
  const db = await F.openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'dirHandle');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Write the display marker only after the real handle is persisted.
  await chrome.storage.local.set({ folderName: handle.name, folderSet: true });
  // Verify by reading back through the shared module.
  if (!(await F.readHandle())) {
    throw new Error('Handle verification failed — could not read back from storage');
  }
  // Notify offscreen document to reload its handle
  chrome.runtime.sendMessage({ action: 'RELOAD_HANDLE' }).catch(() => {});
}

async function loadDirectoryHandle() {
  return F.readHandle();
}

async function clearDirectoryHandle() {
  // Only the explicit "Clear" button deletes config — both marker and handle.
  await chrome.storage.local.remove(['folderName', 'folderSet']);
  const db = await F.openDB();
  await new Promise((resolve) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete('dirHandle');
    tx.oncomplete = () => resolve();
  });
  chrome.runtime.sendMessage({ action: 'RELOAD_HANDLE' }).catch(() => {});
}

// --- UI ---

const folderPathEl = document.getElementById('folder-path');
const folderHintEl = document.getElementById('folder-hint');
const pickBtn = document.getElementById('pick-folder-btn');
const reauthBtn = document.getElementById('reauth-folder-btn');
const reauthTipEl = document.getElementById('reauth-tip');
const clearBtn = document.getElementById('clear-folder-btn');
const syncIndexToolsEl = document.getElementById('sync-index-tools');
const toastEl = document.getElementById('toast');

function showToast(msg, success) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (success ? ' success' : '');
  setTimeout(() => { toastEl.className = 'toast hidden'; }, 2500);
}

async function renderFolderStatus() {
  // D7: heal a marker wrongly cleared by the old failure path, but only
  // when a real handle still exists (a genuine "Clear" removed both).
  await F.restoreMark();
  const state = await F.getFolderState();

  folderPathEl.classList.remove('selected', 'needs-auth');
  if (state.state === 'unconfigured') {
    folderPathEl.textContent = t('optionsFolderNotSelected');
    folderHintEl.textContent = t('optionsFolderHint');
    reauthBtn.hidden = true;
  } else if (state.state === 'needs_auth') {
    folderPathEl.textContent = state.name;
    folderPathEl.classList.add('selected', 'needs-auth');
    folderHintEl.textContent = t('optionsFolderNeedsAuth');
    reauthBtn.hidden = false;
  } else {
    folderPathEl.textContent = state.name;
    folderPathEl.classList.add('selected');
    folderHintEl.textContent = t('optionsFolderReady');
    reauthBtn.hidden = true;
  }
  // The permission reminder only makes sense when re-authorization is shown.
  reauthTipEl.hidden = reauthBtn.hidden;
}

// --- Check File System Access API availability ---
const hasFileSystemAccess = typeof window.showDirectoryPicker === 'function';

if (!hasFileSystemAccess) {
  pickBtn.disabled = true;
  pickBtn.title = t('optionsFolderNotSupported');
  folderHintEl.textContent = t('optionsFolderNotSupportedHint');
}

// Init
onI18nReady(async () => {
  chrome.storage.local.get(['saveMode', 'outputStructure', 'uiLanguage', 'overwriteExisting', 'syncIndexTools'], (result) => {
    if (result.saveMode) {
      const r = document.querySelector(`input[name="saveMode"][value="${result.saveMode}"]`);
      if (r) r.checked = true;
    }
    const overwriteValue = result.overwriteExisting ? 'true' : 'false';
    const overwriteRadio = document.querySelector(`input[name="overwriteExisting"][value="${overwriteValue}"]`);
    if (overwriteRadio) overwriteRadio.checked = true;
    syncIndexToolsEl.checked = result.syncIndexTools !== false;
    if (result.outputStructure) {
      const r = document.querySelector(`input[name="outputStructure"][value="${result.outputStructure}"]`);
      if (r) r.checked = true;
    }
    if (result.uiLanguage) {
      const r = document.querySelector(`input[name="uiLanguage"][value="${result.uiLanguage}"]`);
      if (r) r.checked = true;
    } else {
      const curLang = getCurrentLang();
      const r = document.querySelector(`input[name="uiLanguage"][value="${curLang}"]`);
      if (r) r.checked = true;
    }
  });
  await renderFolderStatus();
});

// Language switch — real-time
document.querySelectorAll('input[name="uiLanguage"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const lang = radio.value;
    switchLang(lang);
    chrome.storage.local.set({ uiLanguage: lang }, () => {
      applyI18n();
      renderFolderStatus();
      showToast(t('optionsLanguageSaved'), true);
    });
  });
});

// Pick folder (only path that opens the OS directory picker)
pickBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await storeDirectoryHandle(handle);
    await renderFolderStatus();
    showToast(t('optionsFolderSelected', [handle.name]), true);
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(t('optionsAccessError') + ': ' + err.message, false);
    }
  }
});

// Re-authorize the already-stored folder — never re-picks a directory.
reauthBtn.addEventListener('click', async () => {
  const handle = await F.readHandle();
  if (!handle) {
    await renderFolderStatus();
    showToast(t('optionsAccessError'), false);
    return;
  }
  const result = await F.requestPermission(handle);
  if (result === 'granted') {
    await renderFolderStatus();
    showToast(t('optionsReauthSuccess'), true);
  } else {
    showToast(t('optionsReauthFailed'), false);
  }
});

// Clear folder (the only action that deletes config and handle)
clearBtn.addEventListener('click', async () => {
  await clearDirectoryHandle();
  await renderFolderStatus();
  showToast(t('optionsFolderCleared'));
});

// Index tools deployment (save-to-folder only; default ON)
syncIndexToolsEl.addEventListener('change', () => {
  chrome.storage.local.set({ syncIndexTools: syncIndexToolsEl.checked });
  showToast(t('optionsIndexToolsSaved'), true);
});

// Output structure
document.querySelectorAll('input[name="outputStructure"]').forEach(radio => {
  radio.addEventListener('change', () => {
    chrome.storage.local.set({ outputStructure: radio.value });
    showToast(t('optionsOutputSaved'), true);
  });
});

// Save mode
document.querySelectorAll('input[name="saveMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    chrome.storage.local.set({ saveMode: radio.value });
    showToast(t('optionsModeSaved'), true);
  });
});

// Duplicate saves
document.querySelectorAll('input[name="overwriteExisting"]').forEach(radio => {
  radio.addEventListener('change', () => {
    chrome.storage.local.set({ overwriteExisting: radio.value === 'true' });
    showToast(t('optionsDuplicateSaved'), true);
  });
});
