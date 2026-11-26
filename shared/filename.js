// shared/filename.js — File System Access safe names.
//
// Chromium rejects an entry name in getFileHandle()/getDirectoryHandle() when
// it is empty, contains a path separator, has illegal platform characters,
// ends with '.' or whitespace, is a Windows reserved name, or has a dangerous
// extension. Downloads (and JSZip) are more permissive, which is why a title
// ending in "..." could be downloaded as a zip but could not be used as an
// Obsidian assets directory name.
//
// Keep this module dependency-free so it can be loaded with importScripts()
// in the service worker and with <script> in any extension page.

(function () {
  'use strict';

  var ILLEGAL_ANYWHERE = /["*/:<>?\\|]/g;
  var INVISIBLE = /[\p{Cc}\p{Cf}\p{Cn}]/gu;
  var EDGE_NOISE = /^[.~\s]+|[.~\s]+$/gu;
  var RESERVED_WINDOWS = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  var DANGEROUS_EXT = /\.(?:lnk|scf|url|exe|msi|msp|bat|cmd|scr|pif|cpl|hta|jse|vbe|vbs|js|wsf|wsh|ps1|jar|appref-ms)$/i;
  var CLSID_EXT = /\.{[^}]*\}$/;

  function sanitize(name, maxLength) {
    var limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 100;
    var out = String(name == null ? '' : name)
      .replace(ILLEGAL_ANYWHERE, '-')
      .replace(INVISIBLE, '')
      .trim()
      .replace(/\s+/gu, '_');

    // Slice by code point so a truncated emoji is never left as a lone
    // surrogate. Remove edge noise again in case truncation exposed it.
    out = Array.from(out).slice(0, limit).join('').replace(EDGE_NOISE, '');

    if (!out) return 'wechat-article';

    // A short name containing '~' can be mistaken for a VFAT 8.3 short name.
    if (out.length <= 12 && out.indexOf('~') !== -1) {
      out = out.replace(/~/g, '-');
    }

    if (RESERVED_WINDOWS.test(out) || DANGEROUS_EXT.test(out) || CLSID_EXT.test(out)) {
      out += '_';
    }

    return out || 'wechat-article';
  }

  globalThis.__WMS_FILENAME__ = { sanitize: sanitize };
})();
