// shared/time.js — Time formatting for the YAML frontmatter metadata fields.
// Both saved_at and date are rendered in a FIXED Beijing timezone (UTC+08:00)
// with an explicit "+08:00" suffix, independent of the device timezone, so a
// file saved anywhere in the world carries the same wall-clock convention.
//
// Loaded via importScripts() in the service worker, via <script src> in
// extension pages and content scripts, and via require() in the Node.js
// repair script. It only uses plain Date math, so it works in all environments.

(function () {
  'use strict';

  const BEIJING_OFFSET_MINUTES = 8 * 60;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // Render an instant as Beijing wall-clock (UTC+8) with a "+08:00" suffix.
  // Uses getUTC* after shifting the timestamp, so the device timezone never
  // leaks into the result.
  function formatBeijing(date) {
    const d = date instanceof Date ? date : new Date(date);
    const shifted = new Date(d.getTime() + BEIJING_OFFSET_MINUTES * 60000);
    const ymd = shifted.getUTCFullYear() + '-' + pad2(shifted.getUTCMonth() + 1) + '-' + pad2(shifted.getUTCDate());
    const hms = pad2(shifted.getUTCHours()) + ':' + pad2(shifted.getUTCMinutes()) + ':' + pad2(shifted.getUTCSeconds());
    return ymd + ' ' + hms + '+08:00';
  }

  function formatSavedAt(date) {
    return formatBeijing(date === undefined ? new Date() : date);
  }

  // getTimezoneOffset() is UTC-minus-local minutes (east of UTC is negative).
  // Kept as a public helper for callers that still need the device offset.
  function formatOffset(date) {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    return sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  // Local wall-clock rendering, no longer used for frontmatter fields.
  // Retained for backwards compatibility with any external caller.
  function formatLocal(date) {
    const d = date instanceof Date ? date : new Date(date);
    const ymd = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const hms = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    return ymd + ' ' + hms + formatOffset(d);
  }

  // WeChat publishes dates in several shapes depending on which DOM node the
  // extractor hits. All are Beijing wall-clock; normalize them to +08:00:
  //   - "2026年10月9日 08:00(:30)" -> "YYYY-MM-DD HH:MM:SS+08:00"
  //   - "2026-10-09 08:00(:30)"    -> "YYYY-MM-DD HH:MM:SS+08:00"
  //   - "2026-10-09T08:00:00Z"     -> true instant re-rendered at UTC+8
  //   - "2026-10-09" / "2026年10月9日" (date only)
  //                                -> "YYYY-MM-DD+08:00" (no invented time)
  //   - unrecognized               -> returned untouched
  const PUBLISH_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  const PUBLISH_CN_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const PUBLISH_DASH_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  function formatPublishDate(raw) {
    const s = String(raw == null ? '' : raw).trim();

    // Full timestamp with an explicit offset: resolve the real instant first.
    const iso = PUBLISH_ISO_RE.exec(s);
    if (iso) {
      if (!iso[7]) {
        return iso[1] + '-' + iso[2] + '-' + iso[3] + ' ' +
               iso[4] + ':' + iso[5] + ':' + iso[6] + '+08:00';
      }
      const parsed = parseDated(s);
      return parsed ? formatBeijing(parsed) : s;
    }

    // Chinese form, with or without a time component.
    const cn = PUBLISH_CN_RE.exec(s);
    if (cn) {
      const ymd = cn[1] + '-' + pad2(+cn[2]) + '-' + pad2(+cn[3]);
      if (cn[4] == null) return ymd + '+08:00';
      return ymd + ' ' + pad2(+cn[4]) + ':' + pad2(+cn[5]) + ':' + pad2(+(cn[6] || 0)) + '+08:00';
    }

    // Dash form with no seconds, or a date-only value.
    const dash = PUBLISH_DASH_RE.exec(s);
    if (dash) {
      const ymd = dash[1] + '-' + dash[2] + '-' + dash[3];
      if (dash[4] == null) return ymd + '+08:00';
      return ymd + ' ' + pad2(+dash[4]) + ':' + pad2(+dash[5]) + ':' + pad2(+(dash[6] || 0)) + '+08:00';
    }

    return s;
  }

  // A date value already normalized to either "YYYY-MM-DD+08:00" (date only)
  // or "YYYY-MM-DD HH:MM:SS+08:00" is left untouched by the repair script.
  function isNormalizedDate(value) {
    return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?\+08:00$/.test(String(value == null ? '' : value).trim());
  }

  // Legacy saved_at values were UTC written as "YYYY-MM-DD HH:MM:SS".
  const LEGACY_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
  // Current values carry an explicit offset, e.g. "...+08:00" or "...-05:00".
  const CURRENT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  const OFFSET_RE = /([+-])(\d{2}):(\d{2})$/;

  function isLegacy(value) {
    return LEGACY_RE.test(String(value == null ? '' : value).trim());
  }

  function isCurrent(value) {
    return CURRENT_RE.test(String(value == null ? '' : value).trim());
  }

  function isBeijing(value) {
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00$/.test(String(value == null ? '' : value).trim());
  }

  // Parse a wall-clock string with an optional offset. A value with no offset
  // is treated as UTC (that is what the old saved_at writer produced).
  function parseDated(value) {
    const s = String(value == null ? '' : value).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) return null;

    let offsetMinutes = 0;
    if (m[7] && m[7] !== 'Z') {
      const sign = m[7][0] === '-' ? -1 : 1;
      const parts = m[7].slice(1).split(':');
      offsetMinutes = sign * (parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10));
    }
    const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMinutes * 60000;
    const d = new Date(utcMs);
    return isNaN(d.getTime()) ? null : d;
  }

  // Interpret a legacy no-suffix value as a UTC instant.
  function parseLegacyUtc(value) {
    if (!isLegacy(value)) return null;
    return parseDated(String(value).trim());
  }

  // Normalize a saved_at value to Beijing time:
  //   - already "+08:00"     : unchanged (idempotent)
  //   - other offset suffix  : resolve the instant, re-render at UTC+8
  //   - no suffix (legacy)   : treat as UTC, render at UTC+8
  //   - unrecognized         : returned untouched so odd data is never corrupted
  function normalizeSavedAt(value) {
    const raw = String(value == null ? '' : value).trim();
    if (isBeijing(raw)) return raw;
    if (!isLegacy(raw) && !isCurrent(raw)) return raw;
    const d = parseDated(raw);
    return d ? formatBeijing(d) : raw;
  }

  globalThis.__WMS_TIME__ = {
    formatSavedAt: formatSavedAt,
    formatBeijing: formatBeijing,
    formatPublishDate: formatPublishDate,
    isNormalizedDate: isNormalizedDate,
    formatOffset: formatOffset,
    formatLocal: formatLocal,
    isLegacy: isLegacy,
    isCurrent: isCurrent,
    isBeijing: isBeijing,
    parseLegacyUtc: parseLegacyUtc,
    normalizeSavedAt: normalizeSavedAt
  };
})();
