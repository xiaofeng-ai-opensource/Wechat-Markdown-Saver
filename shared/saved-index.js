// shared/saved-index.js — Duplicate-save index stored inside the target folder.
//
// The index is a small JSON file at the root of the folder the user picked.
// It is written ONLY after an article was saved successfully, so failed
// writes and zip fallbacks never leave a false "already saved" record.
//
// Loaded via importScripts() in the service worker, via <script src> in the
// offscreen document, and via vm/require() in the Node.js logic test. All
// filesystem access goes through the passed-in FileSystemDirectoryHandle so
// the module can be tested with an in-memory stub.

(function () {
  'use strict';

  const INDEX_FILE = '.wechat-md-saver.json';
  const VERSION = 1;

  // Canonical identity of an article: origin + pathname, with tracking query
  // parameters, fragments, trailing slashes and host casing removed.
  function normalizeUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const s = raw.trim();
    try {
      const u = new URL(s);
      const path = u.pathname.replace(/\/+$/, '');
      return u.protocol.toLowerCase() + '//' + u.hostname.toLowerCase() + path;
    } catch (e) {
      return s.replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
  }

  function emptyIndex() {
    return { version: VERSION, articles: {} };
  }

  // Look up a recorded article. Returns the stored metadata or null.
  function lookup(index, url) {
    if (!index || !index.articles) return null;
    const key = normalizeUrl(url);
    if (!key) return null;
    return index.articles[key] || null;
  }

  // Add or refresh a record. Mutates and returns the index entry.
  function upsert(index, url, meta) {
    const key = normalizeUrl(url);
    if (!key) return null;
    if (!index.articles) index.articles = {};
    const prev = index.articles[key] || {};
    index.articles[key] = Object.assign({}, prev, meta || {});
    return index.articles[key];
  }

  // Read a frontmatter field from the leading --- ... --- block only.
  function extractFrontmatterField(md, field) {
    if (typeof md !== 'string') return null;
    const lines = md.split(/\r?\n/);
    if (lines[0].trim() !== '---') return null;
    const re = new RegExp('^' + field + ':\\s*(.*)$');
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') break;
      const m = lines[i].match(re);
      if (m) {
        let v = m[1].trim();
        if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
    return null;
  }

  // Read the index. Returns null when the file is missing or unreadable.
  async function readIndex(dirHandle) {
    if (!dirHandle) return null;
    try {
      const fileHandle = await dirHandle.getFileHandle(INDEX_FILE);
      const text = await (await fileHandle.getFile()).text();
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== VERSION || !parsed.articles || typeof parsed.articles !== 'object') {
        return null;
      }
      return parsed;
    } catch (e) {
      return null;
    }
  }

  async function writeIndex(dirHandle, index) {
    if (!dirHandle) throw new Error('No directory handle');
    const fileHandle = await dirHandle.getFileHandle(INDEX_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index, null, 2) + '\n');
    await writable.close();
  }

  // Build an index from article directories that already exist in the folder.
  // Only directories containing a Markdown file with a `source:` field count
  // as "already saved" data. No source field means no record.
  async function buildIndexFromDirectory(dirHandle) {
    const index = emptyIndex();
    if (!dirHandle || !dirHandle.entries) return index;
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        if (!handle || handle.kind !== 'directory') continue;
        let mdHandle = null;
        let mdName = null;
        try {
          mdHandle = await handle.getFileHandle('article.md');
          mdName = 'article.md';
        } catch (e) {
          try {
            for await (const [fname, fhandle] of handle.entries()) {
              if (fhandle && fhandle.kind === 'file' && /\.md$/i.test(fname)) {
                mdHandle = fhandle;
                mdName = fname;
                break;
              }
            }
          } catch (e2) { /* unreadable directory: skip it */ }
        }
        if (!mdHandle) continue;
        let md;
        try {
          md = await (await mdHandle.getFile()).text();
        } catch (e) { continue; }
        const source = extractFrontmatterField(md, 'source');
        if (!source) continue;
        const key = normalizeUrl(source);
        if (!key) continue;
        const title = extractFrontmatterField(md, 'title') || '';
        const savedAt = extractFrontmatterField(md, 'saved_at') || null;
        // dirName carries a base36 timestamp suffix; recover the safe title
        // that produced it so an overwrite can target the same Markdown file.
        const safeTitle = mdName === 'article.md'
          ? name.replace(/_[0-9a-z]+$/, '')
          : mdName.replace(/\.md$/i, '');
        index.articles[key] = {
          dirName: name,
          safeTitle: safeTitle,
          title: title,
          savedAt: savedAt,
          outputStructure: mdName === 'article.md' ? 'simple' : 'obsidian'
        };
      }
    } catch (e) { /* partial scan is better than blocking the save */ }
    return index;
  }

  // Read the index, or create it on first use by scanning existing articles.
  async function ensureIndex(dirHandle) {
    const existing = await readIndex(dirHandle);
    if (existing) return existing;
    const built = await buildIndexFromDirectory(dirHandle);
    await writeIndex(dirHandle, built);
    return built;
  }

  globalThis.__WMS_SAVED_INDEX__ = {
    INDEX_FILE: INDEX_FILE,
    VERSION: VERSION,
    normalizeUrl: normalizeUrl,
    emptyIndex: emptyIndex,
    lookup: lookup,
    upsert: upsert,
    extractFrontmatterField: extractFrontmatterField,
    readIndex: readIndex,
    writeIndex: writeIndex,
    buildIndexFromDirectory: buildIndexFromDirectory,
    ensureIndex: ensureIndex
  };
})();
