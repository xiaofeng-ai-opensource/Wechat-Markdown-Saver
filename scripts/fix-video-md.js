'use strict';

// One-off repair for saved articles whose video was flattened to a fake
// "> [VIDEO: Video]" placeholder (the iframe carried data-src, not src).
// Usage:
//   node scripts/fix-video-md.js <article.md>            # dry-run
//   node scripts/fix-video-md.js <article.md> --apply    # write with .bak backup
//   node scripts/fix-video-md.js <article.md> --apply --url <player-url>
//
// Default --url is the player link of the 2026-11-23 answer-me-with-html
// article. Pass --url to repair a different article. The script is idempotent:
// lines already converted to "> [视频](...)" are left untouched.

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&auto=0&vid=wxv_4728853441140178947';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
const urlIndex = process.argv.indexOf('--url');
const url = urlIndex >= 0 ? process.argv[urlIndex + 1] : DEFAULT_URL;

if (!file || (urlIndex >= 0 && !url)) {
  console.error('Usage: node scripts/fix-video-md.js <article.md> [--apply] [--url <player-url>]');
  process.exit(1);
}

const target = path.resolve(file);
let raw = fs.readFileSync(target, 'utf8');
const hasBom = raw.charCodeAt(0) === 0xFEFF;
if (hasBom) raw = raw.slice(1);

// Matches the old fake placeholders, with or without a Markdown link part.
const FAKE = /^(\s*>\s*)\[VIDEO:\s*Video\]\s*(\([^)]*\))?\s*$/;
const NEW_LINE = '> [视频](' + url + ')';

const lines = raw.split('\n');
const hits = [];
const updated = lines.map(function (line, index) {
  if (FAKE.test(line)) {
    hits.push(index + 1);
    return NEW_LINE;
  }
  return line;
});

console.log('File: ' + target);
console.log('URL:  ' + url);
console.log('Matched placeholder lines: ' + (hits.length ? hits.join(', ') : '(none)'));

if (hits.length) {
  console.log('--- preview ---');
  hits.forEach(function (lineNo) {
    console.log('L' + lineNo + ': ' + lines[lineNo - 1] + '  ->  ' + NEW_LINE);
  });
  console.log('--- end preview ---');
}

if (!apply) {
  console.log('Dry run only. Add --apply to write (a .bak backup will be created).');
  process.exit(0);
}

if (!hits.length) {
  console.log('Nothing to change; file left as-is.');
  process.exit(0);
}

const output = (hasBom ? '\uFEFF' : '') + updated.join('\n');
const backup = target + '.bak';
fs.copyFileSync(target, backup);
fs.writeFileSync(target, output, 'utf8');
console.log('Backup: ' + backup);
console.log('Written: ' + target);
