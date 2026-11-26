// shared/index-tools.js — Deploy the bundled index/cleanup scripts into the
// folder chosen by the user. Only used by the "save to folder" path.
//
// Design constraints:
//  - The browser can only WRITE files; it cannot execute local scripts.
//  - Missing files are created; existing files are updated to the bundled
//    version (byte comparison avoids needless rewrites).
//  - Every failure is swallowed into a warning flag: index-tool deployment
//    must never block or roll back an article that was saved successfully.

(function () {
  'use strict';

  const TOOLS_DIR = 'index_tools';
  const FILES = ['build_index.py', 'build_index.cmd'];

  function runtimeApi() {
    return (typeof globalThis.__WMS_BROWSER__ !== 'undefined' && globalThis.__WMS_BROWSER__.api)
      ? globalThis.__WMS_BROWSER__.api
      : (globalThis.browser || globalThis.chrome);
  }

  async function bundledBytes(name) {
    const api = runtimeApi();
    if (!api || !api.runtime || !api.runtime.getURL) {
      throw new Error('Extension runtime URL API unavailable');
    }
    const response = await fetch(api.runtime.getURL('index-tools/' + name));
    if (!response || !response.ok) {
      throw new Error('Cannot read bundled ' + name + (response ? ' (HTTP ' + response.status + ')' : ''));
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  function bytesEqual(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  async function currentBytes(fileHandle) {
    try {
      const file = await fileHandle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      // getFileHandle({create:true}) just created an empty file.
      return bytes.length === 0 ? null : bytes;
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {FileSystemDirectoryHandle} dirHandle root save folder
   * @returns {Promise<{created:string[], updated:string[], unchanged:string[], warning:boolean, error:string|null}>}
   */
  async function syncIndexTools(dirHandle) {
    const result = {
      created: [],
      updated: [],
      unchanged: [],
      warning: false,
      error: null
    };
    if (!dirHandle) return result;

    try {
      const toolsDir = await dirHandle.getDirectoryHandle(TOOLS_DIR, { create: true });
      for (const name of FILES) {
        try {
          const bytes = await bundledBytes(name);
          const fileHandle = await toolsDir.getFileHandle(name, { create: true });
          const existing = await currentBytes(fileHandle);
          if (bytesEqual(existing, bytes)) {
            result.unchanged.push(name);
            continue;
          }
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
          if (existing === null) result.created.push(name);
          else result.updated.push(name);
        } catch (e) {
          result.warning = true;
          console.warn('index-tools: could not sync ' + name + ':', e);
        }
      }
    } catch (e) {
      result.warning = true;
      result.error = e && e.message ? e.message : String(e);
      console.warn('index-tools: could not prepare ' + TOOLS_DIR + ':', e);
    }
    return result;
  }

  globalThis.__WMS_INDEX_TOOLS__ = { syncIndexTools };
})();
