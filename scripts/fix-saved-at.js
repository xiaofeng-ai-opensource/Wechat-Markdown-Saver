#!/usr/bin/env node
// scripts/fix-saved-at.js — One-time repair that unifies saved_at and date.
//
// Older extensions wrote saved_at as a UTC wall-clock string with no suffix,
// and date as WeChat's raw Chinese text. This script rewrites both fields to
// a FIXED Beijing convention using shared/time.js, so the repair output
// matches what the extension itself now writes.
//
// Usage:
//   node scripts/fix-saved-at.js <markdown-dir>               # dry run, no writes
//   node scripts/fix-saved-at.js <markdown-dir> --apply       # write + .bak backup
//   node scripts/fix-saved-at.js <markdown-dir> --apply --no-backup
//
// Safety notes:
//   - Only saved_at / date lines inside the leading YAML frontmatter change.
//   - saved_at: already-Beijing values pass through; other offsets are
//     re-resolved to their real instant and re-rendered at UTC+8.
//   - date: Chinese, dash and ISO forms are normalized; date-only values get
//     "+08:00" appended without an invented time. Unrecognized values pass through.
//   - Both rules are idempotent. Backups are created by default with --apply.
//   - UTF-8 BOM and newline style are preserved.

'use strict';

const fs = require('fs');
const path = require('path');

// The shared file is an IIFE that attaches itself to globalThis, so a plain
// require() is enough — no ES module loader needed.
require('../shared/time.js');
const time = globalThis.__WMS_TIME__;

function printUsage() {
  console.log('用法:');
  console.log('  node scripts/fix-saved-at.js <Markdown目录>              # 预览，不写入');
  console.log('  node scripts/fix-saved-at.js <Markdown目录> --apply      # 实际修复并备份');
  console.log('  node scripts/fix-saved-at.js <Markdown目录> --apply --no-backup');
  console.log('');
  console.log('说明:');
  console.log('  - 处理文件开头 frontmatter 内的 saved_at 与 date 两行');
  console.log('  - 固定换算成北京时间（UTC+8），不随设备时区变化');
  console.log('  - saved_at：已是 +08:00 的跳过；其它后缀按真实时刻重算；无后缀旧值按 UTC 换算');
  console.log('  - date：中文/横线/ISO 统一格式；只有日期的补 +08:00 不补时分秒');
  console.log('  - 无法识别的值原样保留，脚本可重复运行');
  console.log('  - --apply 时默认生成 .bak 备份，可加 --no-backup 关闭');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const noBackup = args.includes('--no-backup');
  const positional = args.filter(a => !a.startsWith('--'));

  if (args.includes('--help') || args.includes('-h') || positional.length === 0) {
    printUsage();
    process.exit(positional.length === 0 ? 1 : 0);
  }
  if (positional.length > 1) {
    console.error('错误: 只能指定一个目录。');
    process.exit(1);
  }

  return {
    dir: path.resolve(positional[0]),
    apply: apply,
    backup: apply && !noBackup
  };
}

function walkMarkdown(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

function repairFile(file, apply, backup) {
  const raw = fs.readFileSync(file, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const body = hasBom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);

  // Frontmatter must start at the very first line and be closed by a --- line.
  if (lines[0].trim() !== '---') return { status: 'no-frontmatter' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return { status: 'unterminated-frontmatter' };

  const changes = [];
  for (let i = 1; i < end; i++) {
    const m = /^(\s*(saved_at|date):\s*)(.*?)(\s*)$/.exec(lines[i]);
    if (!m) continue;
    const field = m[2];
    const oldValue = m[3];
    const newValue = field === 'saved_at'
      ? time.normalizeSavedAt(oldValue)
      : time.formatPublishDate(oldValue);
    if (newValue === oldValue) continue;
    changes.push({ field: field, before: oldValue, after: newValue });
    lines[i] = m[1] + newValue + m[4];
  }

  if (changes.length === 0) return { status: 'unchanged' };

  if (apply) {
    if (backup) fs.copyFileSync(file, file + '.bak');
    const output = (hasBom ? '\uFEFF' : '') + lines.join(eol);
    fs.writeFileSync(file, output, 'utf8');
  }

  return { status: apply ? 'fixed' : 'would-fix', changes: changes };
}

function main() {
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    console.error('错误: 目录不存在或不是文件夹: ' + opts.dir);
    process.exit(1);
  }

  const files = walkMarkdown(opts.dir);
  const stats = { scanned: 0, fixed: 0, unchanged: 0, skipped: 0, failed: 0 };
  const mode = opts.apply ? '实际修复' : '预览（DRY RUN，不会写入）';

  console.log('目录: ' + opts.dir);
  console.log('运行模式: ' + mode);
  console.log('目标时区: 北京时间 UTC+8（与设备时区无关）');
  console.log('');

  for (const file of files) {
    stats.scanned++;
    try {
      const result = repairFile(file, opts.apply, opts.backup);
      if (result.status === 'unchanged') {
        stats.unchanged++;
      } else if (result.status === 'no-frontmatter' || result.status === 'unterminated-frontmatter') {
        stats.skipped++;
      } else {
        stats.fixed++;
        console.log('[' + result.status + '] ' + path.relative(opts.dir, file));
        for (const change of result.changes) {
          console.log('  - ' + change.field + ': ' + change.before);
          console.log('  + ' + change.field + ': ' + change.after);
        }
      }
    } catch (err) {
      stats.failed++;
      console.error('[ERROR] ' + path.relative(opts.dir, file) + ': ' + err.message);
    }
  }

  console.log('');
  console.log('扫描 .md 文件: ' + stats.scanned);
  console.log('需修复: ' + stats.fixed);
  console.log('无需改动: ' + stats.unchanged);
  console.log('跳过（无 frontmatter）: ' + stats.skipped);
  console.log('失败: ' + stats.failed);

  if (!opts.apply && stats.fixed > 0) {
    console.log('');
    console.log('以上仅为预览。确认无误后加 --apply 实际写入（默认生成 .bak 备份）。');
  }
}

main();
