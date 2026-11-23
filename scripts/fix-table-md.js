'use strict';

// One-off repair for the flattened comparison table in the saved article.
// Usage:
//   node scripts/fix-table-md.js <article.md>            # dry-run
//   node scripts/fix-table-md.js <article.md> --apply    # write with .bak backup
//
// The flattened block starts at a line containing only "对比项" and ends
// before the line beginning with "一句话总结". Every 4 non-empty lines are
// one original table row.

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const apply = process.argv.includes('--apply');
const COLUMNS = 4;
const HEADER_TEXT = '对比项';
const END_PREFIX = '一句话总结';

if (!file) {
  console.error('Usage: node scripts/fix-table-md.js <article.md> [--apply]');
  process.exit(1);
}

const target = path.resolve(file);
let raw = fs.readFileSync(target, 'utf8');
const hasBom = raw.charCodeAt(0) === 0xFEFF;
if (hasBom) raw = raw.slice(1);

const lines = raw.split('\n');
const start = lines.findIndex(function (line) { return line.trim() === HEADER_TEXT; });
if (start < 0) {
  console.error('Cannot find header line: ' + HEADER_TEXT);
  process.exit(1);
}

let end = lines.findIndex(function (line, index) {
  return index > start && line.trim().startsWith(END_PREFIX);
});
if (end < 0) end = lines.length;

const cells = [];
for (let i = start; i < end; i++) {
  const value = lines[i].trim();
  if (value) cells.push(value);
}

if (cells.length === 0 || cells.length % COLUMNS !== 0) {
  console.error('Unexpected cell count: ' + cells.length + ' (must be a positive multiple of ' + COLUMNS + ')');
  process.exit(1);
}

function cell(text) {
  return text.replace(/\|/g, '\\|');
}

const tableLines = [];
for (let i = 0; i < cells.length; i += COLUMNS) {
  const row = cells.slice(i, i + COLUMNS).map(cell);
  tableLines.push('| ' + row.join(' | ') + ' |');
  if (i === 0) {
    tableLines.push('| ' + Array(COLUMNS).fill(':---').join(' | ') + ' |');
  }
}

const updated = lines.slice(0, start).concat(tableLines, [''], lines.slice(end));
const output = (hasBom ? '\uFEFF' : '') + updated.join('\n');
const rowCount = cells.length / COLUMNS;

console.log('File: ' + target);
console.log('Block: lines ' + (start + 1) + '-' + end + ' -> ' + rowCount + ' rows x ' + COLUMNS + ' columns');
console.log('--- preview ---');
console.log(tableLines.join('\n'));
console.log('--- end preview ---');

if (!apply) {
  console.log('Dry run only. Add --apply to write (a .bak backup will be created).');
  process.exit(0);
}

const backup = target + '.bak';
fs.copyFileSync(target, backup);
fs.writeFileSync(target, output, 'utf8');
console.log('Backup: ' + backup);
console.log('Written: ' + target);
