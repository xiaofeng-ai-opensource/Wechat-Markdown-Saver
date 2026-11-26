#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate and maintain the document index for this workspace.

Modes
-----
full         Re-parse every document, rebuild INDEX.md and the state file.
incremental  Reuse cached metadata, re-parse only added / changed documents.
check        Health report (read-only): index consistency, dirty article
             directories, duplicate source links, and suspected duplicates
             (same title under a different short-link suffix). Writes nothing.
cleanup      Interactive: list dirty article directories and duplicate
             documents, then move them to the Recycle Bin after the user
             confirms with y / yes / 1 (case-insensitive). Writes
             index_tools/cleanup-report.json.

``full`` and ``incremental`` run the health report before writing; when dirty
data is found they pause for confirmation (interactive terminals only, a
non-interactive run continues so automation is never blocked).

All modes also report groups of documents sharing the same ``source`` link.

The publication time is the ``date`` field in each document's front matter.
Both Chinese (``2026年11月1日 00:00``) and ISO (``2026-11-01 00:00+08:00``)
strings are normalised to ISO 8601 before sorting. The index is grouped by
the ``author`` field (the WeChat official account); groups are ordered by the
newest publication date inside each group, entries inside a group keep the
original descending-date order.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import sys
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

STATE_VERSION = 1
INDEX_NAME = "INDEX.md"
STATE_NAME = ".index_state.json"
BACKUP_NAME = "INDEX.bak.md"
CLEANUP_REPORT_NAME = "cleanup-report.json"
TOOLS_DIRNAME = "index_tools"
EXCLUDE_DIRS = {"assets", "index_tools"}
REQUIRED_FRONT_FIELDS = ("date", "title", "source")
TRACKING_PARAMS = {"chksm", "scene", "srcid"}
TRACKING_PREFIXES = ("utm_", "sharer_")
DUPLICATE_MARK = "【重复】"

DATE_RE = re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}")
UNKNOWN_ACCOUNT = "未标注公众号"
FRONT_RE = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL
)
ROW_RE = re.compile(r"^\|\s*\d{4}-\d{2}-\d{2} ")
CELL_SPLIT_RE = re.compile(r"(?<!\\)\|")
SHORT_SUFFIX_RE = re.compile(r"_mwx[a-z0-9]{4,}$", re.IGNORECASE)
TRAILING_ELLIPSIS_RE = re.compile(r"[\.…]{2,}$")


def setup_console():
    """Make Chinese output readable both from the menu and from a bare shell."""
    if os.name == "nt":
        os.system("chcp 65001 >nul")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass


def log(message: str = "") -> None:
    print(message, flush=True)


def is_yes(answer: str) -> bool:
    """Accept y / yes / 1 in any letter case; anything else is a no."""
    return answer.strip().lower() in ("y", "yes", "1")


def _has_interactive_console() -> bool:
    """True only when stdin is a real console (not a pipe / redirected file)."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        import msvcrt
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        mode = ctypes.c_ulong()
        return bool(ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)))
    except (ImportError, OSError, ValueError, AttributeError):
        return False


def read_single_key(prompt: str) -> str | None:
    """Read one keystroke immediately - no Enter required, like the CMD menu.

    Uses msvcrt only on a real console; pipes / redirected stdin fall back to
    a line read so automation never blocks. Returns the lower-cased key, or
    None when no input is available at all.
    """
    print(prompt, end="", flush=True)
    if _has_interactive_console():
        try:
            import msvcrt
            key = msvcrt.getwch()
            if key.isprintable():
                print(key, end="", flush=True)
            print(flush=True)
            return key.strip().lower()
        except (ImportError, OSError, ValueError):
            pass
    try:
        return input().strip().lower()[:1]
    except EOFError:
        return None


def parse_front(text: str):
    """Return the front matter as a dict, or None when it is missing."""
    match = FRONT_RE.match(text)
    if not match:
        return None
    fields = {}
    for line in match.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        value = value.replace('\\"', '"').replace("\\'", "'")
        fields[key.strip()] = value
    return fields


def parse_date(raw: str):
    """Normalise a Chinese or ISO ``date`` value into a datetime, or return None."""
    value = raw.strip()
    match = DATE_RE.match(value)
    if match:
        year, month, day, hour, minute = (int(part) for part in match.groups())
        try:
            return datetime(year, month, day, hour, minute)
        except ValueError:
            return None
    if ISO_DATE_RE.match(value):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None)
        return parsed
    return None


def scan_docs(root: Path) -> dict[str, Path]:
    """Collect .md files exactly one directory below root."""
    docs = {}
    for path in sorted(root.glob("*/*.md")):
        if path.name == INDEX_NAME:
            continue
        parents = path.relative_to(root).parts[:-1]
        if any(
            part.startswith(".")
            or part.lower() in EXCLUDE_DIRS
            or part.lower() == "assets"
            for part in parents
        ):
            continue
        docs[path.relative_to(root).as_posix()] = path
    return docs


def signature(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def collect(path: Path, rel: str):
    """Parse one document. Return (entry, error_message)."""
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            head = handle.read(8192)
    except OSError as exc:
        return None, f"无法读取文件：{exc}"
    fields = parse_front(head)
    if fields is None:
        return None, "缺少头部属性区（YAML front matter）"
    raw_date = fields.get("date", "")
    date_value = parse_date(raw_date)
    if date_value is None:
        return None, (
            f"date 格式无法识别：{raw_date!r}"
            "（应为 2026年11月1日 00:00 或 2026-11-01 00:00+08:00）"
        )
    size, mtime_ns = signature(path)
    entry = {
        "path": rel,
        "size": size,
        "mtime_ns": mtime_ns,
        "title": fields.get("title", "").strip() or path.stem,
        "date_raw": raw_date,
        "date_iso": date_value.strftime("%Y-%m-%d %H:%M"),
        "source": fields.get("source", "").strip(),
        "saved_at": fields.get("saved_at", "").strip(),
        "author": fields.get("author", "").strip(),
    }
    return entry, None


def load_state(state_path: Path):
    if not state_path.is_file():
        return None
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("version") != STATE_VERSION or not isinstance(data.get("entries"), dict):
        return None
    return data


def build_entries(root: Path, mode: str, state):
    docs = scan_docs(root)
    cached = (state or {}).get("entries", {})
    entries = []
    issues = []
    changed_paths = []
    stats = {"added": 0, "changed": 0, "reused": 0, "removed": 0, "skipped": 0}

    for rel, path in docs.items():
        old = cached.get(rel)
        need_parse = (
            mode in ("full", "check")
            or old is None
            or (old.get("size"), old.get("mtime_ns")) != signature(path)
        )
        if not need_parse:
            entries.append(old)
            stats["reused"] += 1
            continue
        entry, error = collect(path, rel)
        if error:
            issues.append((rel, error))
            stats["skipped"] += 1
            continue
        entries.append(entry)
        changed_paths.append(rel)
        if old is None:
            stats["added"] += 1
        else:
            stats["changed"] += 1

    removed = sorted(set(cached) - set(docs))
    stats["removed"] = len(removed)
    return entries, issues, stats, changed_paths, removed, len(docs)


def sort_entries(entries: list[dict]) -> list[dict]:
    """Descending by publication time; equal dates keep a stable title order."""
    entries.sort(key=lambda item: item.get("title", ""))
    entries.sort(key=lambda item: item.get("date_iso", ""), reverse=True)
    return entries


def group_entries(entries: list[dict]) -> list[tuple[str, list[dict]]]:
    """Group entries by ``author`` (the WeChat official account).

    Groups are ordered by the newest publication date inside each group;
    equal dates keep an alphabetical account order. Entry order inside a
    group is whatever ``sort_entries`` produced (newest first).
    """
    buckets: dict[str, list[dict]] = {}
    for entry in entries:
        account = (entry.get("author") or "").strip() or UNKNOWN_ACCOUNT
        buckets.setdefault(account, []).append(entry)
    groups = []
    for account, items in buckets.items():
        latest = max((item.get("date_iso", "") for item in items), default="")
        groups.append((account, items, latest))
    groups.sort(key=lambda group: group[0])
    groups.sort(key=lambda group: group[2], reverse=True)
    return [(account, items) for account, items, _ in groups]


def group_heading(account: str, count: int) -> str:
    return f"## {account}（{count} 篇）"


def normalise_source(raw: str) -> str:
    """Lightly normalise an origin URL so tracking variants compare equal.

    Path case is preserved because short links are case sensitive. Article
    identifiers such as __biz / mid / idx / sn stay in the query string.
    """
    value = (raw or "").strip()
    if not value:
        return ""
    value = value.split("#", 1)[0]
    parts = urlsplit(value)
    kept = []
    for key, val in parse_qsl(parts.query, keep_blank_values=True):
        lower = key.lower()
        if lower in TRACKING_PARAMS or lower.startswith(TRACKING_PREFIXES):
            continue
        kept.append((key, val))
    kept.sort()
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), path, urlencode(kept), "")
    )


def find_duplicates(entries: list[dict]) -> list[dict]:
    """Group entries by their normalised origin URL; return groups with 2+ docs."""
    groups: dict[str, list[dict]] = {}
    for entry in entries:
        key = normalise_source(entry.get("source", ""))
        if not key:
            continue
        groups.setdefault(key, []).append(entry)
    duplicates = []
    for key, items in groups.items():
        if len(items) < 2:
            continue
        items = sorted(
            items,
            key=lambda item: (item.get("date_iso", ""), item.get("path", "")),
            reverse=True,
        )
        duplicates.append({"key": key, "items": items})
    duplicates.sort(key=lambda group: group["key"])
    return duplicates


def duplicate_paths(duplicates: list[dict]) -> set[str]:
    return {item["path"] for group in duplicates for item in group["items"]}


def normalise_dir_title(name: str) -> str:
    """Strip the ``_mwx...`` short-link suffix and trailing ellipsis.

    Failed saves leave names like ``标题..._mwx6zwko`` while the successful
    copy is ``标题_mwx98k37``. Both reduce to ``标题`` so they group together.
    """
    value = SHORT_SUFFIX_RE.sub("", name)
    value = TRAILING_ELLIPSIS_RE.sub("", value)
    return value.strip()


def find_suspected_duplicates(root: Path) -> list[dict]:
    """Group article directories sharing a normalised title (2+ members)."""
    seen: dict[str, list[str]] = {}
    for directory in article_directories(root):
        title = normalise_dir_title(directory.name)
        if not title:
            continue
        seen.setdefault(title, []).append(directory.name)
    groups = [
        {"key": title, "paths": sorted(paths)}
        for title, paths in seen.items()
        if len(paths) > 1
    ]
    groups.sort(key=lambda group: group["key"])
    return groups


def print_dirty_section(dirty: list[dict], valid_count: int) -> None:
    log(f"脏数据检查：发现 {len(dirty)} 项（有效文档 {valid_count} 篇保持不变）")
    for number, item in enumerate(dirty, 1):
        log(f"  {number:2d}. {item['path']} — [{item['reason']}] {item['detail']}")
    if dirty:
        log("  提示：运行清理（菜单 [4] / --mode cleanup）可移入回收站。")


def print_suspected_section(suspected: list[dict]) -> None:
    total = sum(len(group["paths"]) for group in suspected)
    log(f"同名疑似重复：{len(suspected)} 组（涉及 {total} 个目录，按标题去掉短链后缀比对）")
    for group in suspected:
        log(f"  ! {group['key']}（{len(group['paths'])} 个目录）")
        for path in group["paths"]:
            log(f"      - {path}")
    if suspected:
        log("  提示：含空壳目录，运行清理可一并处理；脚本不会自动删除。")


def confirm_write_after_health(dirty: list[dict]) -> bool:
    """Pause before writing when dirty data exists; non-interactive never blocks."""
    if not dirty:
        return True
    if not sys.stdin.isatty():
        log("非交互运行：检测到脏数据，按自动化约定继续写入（未阻断）。")
        return True
    log("")
    answer = read_single_key("检测到脏数据，按 y / 1 继续写入，其它键取消：")
    if answer is None:
        log("非交互运行：检测到脏数据，按自动化约定继续写入（未阻断）。")
        return True
    if is_yes(answer):
        log("继续写入索引。")
        return True
    log("已取消写入，未改动任何文件。")
    return False


def escape_label(text: str) -> str:
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def escape_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def render_row(entry: dict, duplicated: set[str] | None = None) -> str:
    local = f"[{escape_label(entry['title'])}](<{entry['path']}>)"
    if duplicated and entry["path"] in duplicated:
        local += f" {DUPLICATE_MARK}"
    source = entry.get("source", "")
    origin = f"[原文]({source})" if source else "—"
    cells = [
        entry["date_iso"],
        local,
        origin,
        entry.get("saved_at", "") or "—",
    ]
    return "| " + " | ".join(escape_cell(cell) for cell in cells) + " |"


def normalise_row(line: str) -> tuple[str, ...]:
    """Compare a table row by its cell values, ignoring alignment padding."""
    parts = [part.strip() for part in CELL_SPLIT_RE.split(line.strip())]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return tuple(parts)


def render_index(
    groups: list[tuple[str, list[dict]]],
    total: int,
    issues: list,
    duplicates: list[dict],
    mode_label: str,
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    marked = duplicate_paths(duplicates)
    lines = [
        "# 文档索引",
        "",
        f"> 按公众号（`author` 字段）分组，组内按 `date` 字段（发布时间）倒序排列，共 {total} 篇；重复检查：{len(duplicates)} 组。",
        f"> 生成时间：{now}　｜　本次方式：{mode_label}",
        "> 本文件由 `index_tools/build_index.py` 自动生成，请勿手工编辑；更新请运行 `index_tools/build_index.cmd`。",
        "",
    ]
    for account, items in groups:
        lines.extend(
            [
                group_heading(account, len(items)),
                "",
                "| 发布日期 | 标题（本地文档） | 原文链接 | 采集时间 |",
                "| --- | --- | --- | --- |",
            ]
        )
        lines.extend(render_row(entry, marked) for entry in items)
        lines.append("")
    if duplicates:
        lines.extend(
            [
                "",
                "## 重复文档",
                "",
                "以下原文链接对应了多篇文档，请确认是否重复采集（索引保留全部条目，仅作标记）：",
                "",
            ]
        )
        for group in duplicates:
            lines.append(f"- <{group['key']}>（{len(group['items'])} 篇）")
            for item in group["items"]:
                lines.append(f"  - `{item['path']}` — {item.get('date_iso', '')}")
        lines.append("")
    if issues:
        lines.extend(
            [
                "",
                "## 未纳入索引的文档",
                "",
                "以下文档的头部属性区缺少可识别的 `date`，已跳过，修正后重新运行即可自动纳入：",
                "",
            ]
        )
        lines.extend(f"- `{rel}`：{reason}" for rel, reason in issues)
    lines.append("")
    return "\n".join(lines)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(tmp, path)


def write_state(state_path: Path, entries: list[dict], mode: str) -> None:
    data = {
        "version": STATE_VERSION,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": mode,
        "entries": {entry["path"]: entry for entry in entries},
    }
    atomic_write(state_path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


MODE_LABEL = {
    "full": "全量重建",
    "incremental": "增量更新",
    "check": "只校验不写入",
    "cleanup": "清理脏数据",
}


# ── Dirty data cleanup ────────────────────────────────────────────────
#
# Three kinds of dirty data are handled (decision 5.1 a/b/c):
#   no-md                  article directory without any .md (half-written)
#   incomplete-frontmatter .md missing date / title / source
#   duplicate              same normalised source, keep the last saved one
#
# Nothing is deleted outright: every candidate goes to the Windows Recycle
# Bin (FOF_ALLOWUNDO). On non-Windows systems it is moved to a local
# index_tools/.trash/<timestamp>/ folder instead.

class _SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", ctypes.c_uint16),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


FO_DELETE = 3
FOF_ALLOWUNDO = 0x0040
FOF_NOCONFIRMATION = 0x0010
FOF_NOERRORUI = 0x0400
FOF_SILENT = 0x0004


def recycle_path(path: Path, fallback_root: Path) -> tuple[bool, str]:
    """Send path to the Recycle Bin; return (ok, destination_description)."""
    if os.name == "nt":
        try:
            op = _SHFILEOPSTRUCTW()
            op.hwnd = None
            op.wFunc = FO_DELETE
            # SHFileOperationW expects a double-NUL terminated path list.
            buf = ctypes.create_unicode_buffer(str(path) + "\0")
            op.pFrom = ctypes.cast(buf, wintypes.LPCWSTR)
            op.pTo = None
            op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
            op.fAnyOperationsAborted = False
            op.hNameMappings = None
            op.lpszProgressTitle = None
            code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
            if code == 0 and not op.fAnyOperationsAborted:
                return True, "recycle-bin"
            return False, f"SHFileOperationW returned {code}"
        except Exception as exc:
            return False, f"recycle-bin unavailable: {exc}"
    try:
        fallback_root.mkdir(parents=True, exist_ok=True)
        dest = fallback_root / path.name
        if dest.exists():
            dest = fallback_root / f"{path.stem}-{datetime.now().strftime('%H%M%S')}{path.suffix}"
        shutil.move(str(path), str(dest))
        return True, str(dest.relative_to(fallback_root.parent.parent))
    except OSError as exc:
        return False, str(exc)


def article_directories(root: Path):
    for path in sorted(root.iterdir()):
        if not path.is_dir() or path.name.startswith("."):
            continue
        if path.name.lower() in EXCLUDE_DIRS:
            continue
        yield path


def fields_of(md_path: Path):
    try:
        head = md_path.read_text(encoding="utf-8-sig", errors="replace")[:8192]
    except OSError:
        return None
    return parse_front(head)


def classify_dirty(root: Path):
    """Return (cleanup_items, valid_entries)."""
    items = []
    valid = []
    for directory in article_directories(root):
        rel = directory.name
        mds = sorted(directory.glob("*.md"))
        if not mds:
            items.append({
                "path": rel,
                "reason": "no-md",
                "detail": "目录内没有 .md 文件（写了一半或失败残留）",
            })
            continue
        fields = fields_of(mds[0])
        if fields is None:
            items.append({
                "path": rel,
                "reason": "no-frontmatter",
                "detail": "缺少 YAML front matter",
            })
            continue
        missing = [key for key in REQUIRED_FRONT_FIELDS if not (fields.get(key) or "").strip()]
        if missing:
            items.append({
                "path": rel,
                "reason": "incomplete-frontmatter",
                "detail": "front matter 缺少字段：" + ", ".join(missing),
            })
            continue
        if parse_date(fields.get("date", "")) is None:
            items.append({
                "path": rel,
                "reason": "bad-date",
                "detail": "date 字段无法识别",
            })
            continue
        valid.append({
            "path": rel,
            "md_path": mds[0],
            "source": fields.get("source", "").strip(),
            "saved_at": fields.get("saved_at", "").strip(),
            "mtime_ns": signature(mds[0])[1],
        })

    # Same source link: keep only the LAST saved valid copy (decision 5.1c).
    groups = {}
    for entry in valid:
        key = normalise_source(entry["source"])
        if not key:
            continue
        groups.setdefault(key, []).append(entry)
    for key, group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda e: (e["saved_at"], e["mtime_ns"], e["path"]))
        keeper = group[-1]
        for entry in group[:-1]:
            items.append({
                "path": entry["path"],
                "reason": "duplicate",
                "detail": "同一原文的旧副本；保留最后保存的 " + keeper["path"],
                "source": key,
            })
    return items, [entry["path"] for entry in valid]


def run_cleanup(root: Path, tools_dir: Path) -> int:
    items, valid = classify_dirty(root)
    if not items:
        log(f"清理检查：未发现脏数据（有效文档 {len(valid)} 篇）。")
        return 0

    log(f"发现 {len(items)} 项待处理（有效文档 {len(valid)} 篇保持不变）：")
    for number, item in enumerate(items, 1):
        log(f"  {number:2d}. {item['path']} — [{item['reason']}] {item['detail']}")
    log("")
    log("确认后这些目录/文档会被移入系统回收站（可从回收站恢复）。")
    answer = read_single_key("按 y 或 1 确认清理（不分大小写），其它键取消：")
    if not is_yes(answer or ""):
        log("已取消，未改动任何文件。")
        return 0

    fallback_root = tools_dir / ".trash" / datetime.now().strftime("%Y%m%d-%H%M%S")
    results = []
    for item in items:
        rel = Path(item["path"])
        target = root / rel
        # Hard guard: only direct children of root, never tools/meta files.
        safe = (
            target.parent == root
            and rel.name not in (INDEX_NAME, TOOLS_DIRNAME, CLEANUP_REPORT_NAME)
            and not rel.name.startswith(".")
            and target.exists()
        )
        if not safe:
            results.append({**item, "status": "skipped", "destination": "protected-or-missing"})
            continue
        ok, destination = recycle_path(target, fallback_root)
        results.append({**item, "status": "moved" if ok else "failed", "destination": destination})
        log(f"  [{'OK' if ok else 'FAIL'}] {item['path']} -> {destination}")

    report = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "root": str(root),
        "valid_documents": len(valid),
        "candidates": len(items),
        "moved": sum(1 for r in results if r["status"] == "moved"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "items": results,
    }
    atomic_write(tools_dir / CLEANUP_REPORT_NAME, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    log(f"清理完成：移入回收站 {report['moved']} 项，失败 {report['failed']} 项，跳过 {report['skipped']} 项。")
    log(f"报告：{tools_dir / CLEANUP_REPORT_NAME}")
    return 0 if report["failed"] == 0 else 1


def main() -> int:
    setup_console()
    parser = argparse.ArgumentParser(description="Build or update the document index.")
    parser.add_argument(
        "--mode",
        choices=("full", "incremental", "check", "cleanup"),
        default="incremental",
        help=(
            "full: re-parse all; incremental: only changed docs; "
            "check: dry run; cleanup: recycle dirty docs (interactive)"
        ),
    )
    parser.add_argument(
        "--root",
        default=None,
        help="Workspace root (defaults to the parent of index-tools). Used for testing.",
    )
    args = parser.parse_args()

    root = (
        Path(args.root).resolve()
        if args.root
        else Path(__file__).resolve().parent.parent
    )
    if not root.is_dir():
        log(f"错误：目录不存在 {root}")
        return 2
    tools_dir = root / TOOLS_DIRNAME
    index_path = root / INDEX_NAME
    state_path = tools_dir / STATE_NAME
    backup_path = tools_dir / BACKUP_NAME

    if args.mode == "cleanup":
        return run_cleanup(root, tools_dir)

    state = load_state(state_path)
    effective_mode = args.mode
    if args.mode == "incremental" and state is None:
        effective_mode = "full"
        log("提示：未找到状态清单（或清单已损坏），本次自动退化为全量重建。")

    entries, issues, stats, changed_paths, removed, scanned = build_entries(
        root, effective_mode, state
    )
    entries = sort_entries(entries)
    duplicates = find_duplicates(entries)
    groups = group_entries(entries)
    dirty_items, valid_dirs = classify_dirty(root)
    suspected = find_suspected_duplicates(root)

    log(f"模式：{MODE_LABEL[effective_mode]}")
    log(f"扫描目录：{root}")
    log(f"扫描到文档：{scanned} 篇")
    if effective_mode == "check":
        log(f"比对结果：按全量口径重算 {scanned} 篇，跳过 {stats['skipped']} 篇（不写入任何文件）")
    else:
        log(
            "比对结果：新增 {added} / 变更 {changed} / 复用 {reused} / 移除 {removed} / 跳过 {skipped}".format(
                **stats
            )
        )
        for rel in changed_paths:
            log(f"  + {rel}")
        for rel in removed:
            log(f"  - {rel}（已从磁盘移除）")
    if issues:
        log("")
        log(f"未纳入索引的文档（{len(issues)} 篇）：")
        for rel, reason in issues:
            log(f"  ! {rel}：{reason}")
    log("")
    duplicated_docs = sum(len(group["items"]) for group in duplicates)
    log(
        f"重复检查：发现 {len(duplicates)} 组重复原文链接"
        f"（涉及 {duplicated_docs} 篇文档）"
    )
    for group in duplicates:
        log(f"  ! <{group['key']}>（{len(group['items'])} 篇）")
        for item in group["items"]:
            log(f"      - {item['path']} — {item.get('date_iso', '')}")
    if duplicates:
        log("  提示：仅作标记，未删除或修改任何文档；索引保留全部条目。")
    log("")
    print_dirty_section(dirty_items, len(valid_dirs))
    log("")
    print_suspected_section(suspected)
    log("")
    log(f"公众号分组：{len(groups)} 个（按组内最新发布时间倒序）")
    for account, items in groups:
        latest = max(item.get("date_iso", "") for item in items)
        log(f"  * {account}：{len(items)} 篇，最新 {latest}")
    log("")

    if effective_mode == "check":
        current = (
            index_path.read_text(encoding="utf-8-sig")
            if index_path.is_file()
            else ""
        )
        marked = duplicate_paths(duplicates)
        expected_rows = [
            render_row(entry, marked) for _, items in groups for entry in items
        ]
        actual_rows = [
            line for line in current.splitlines() if ROW_RE.match(line)
        ]
        expected_norm = [normalise_row(row) for row in expected_rows]
        actual_norm = [normalise_row(row) for row in actual_rows]
        expected_headings = [
            group_heading(account, len(items)) for account, items in groups
        ]
        actual_headings = [
            line.strip()
            for line in current.splitlines()
            if line.startswith("## ")
            and line.strip() not in ("## 重复文档", "## 未纳入索引的文档")
        ]
        rows_ok = actual_norm == expected_norm
        headings_ok = actual_headings == expected_headings
        consistent = rows_ok and headings_ok
        if consistent:
            log(
                f"校验通过：现有索引与磁盘文档一致，共 {len(expected_rows)} 条、"
                f"{len(expected_headings)} 个公众号分组，顺序正确。"
            )
        else:
            if not headings_ok:
                log(
                    f"校验不一致：公众号分组标题现有 {len(actual_headings)} 个，"
                    f"期望 {len(expected_headings)} 个（或顺序不同）。"
                )
                log(f"  现有：{actual_headings}")
                log(f"  期望：{expected_headings}")
            if not rows_ok:
                log(
                    f"校验不一致：现有索引 {len(actual_rows)} 条，期望 {len(expected_rows)} 条。"
                )
                missing = [row for row in expected_norm if row not in actual_norm]
                extra = [row for row in actual_norm if row not in expected_norm]
                if len(expected_rows) != len(actual_rows) or missing or extra:
                    log(f"  需要补入 {len(missing)} 条，需要移除 {len(extra)} 条。")
                elif actual_norm != expected_norm:
                    log("  条目相同但排列顺序不同（应重新生成以修正排序）。")
        if issues:
            log(f"提示：另有 {len(issues)} 篇文档未纳入索引，修正 date 后重新运行即可。")
        if duplicates:
            log(
                f"提示：存在 {len(duplicates)} 组重复原文链接，属警告项，不影响本次校验结论。"
            )
        log("本次为只校验模式，未写入任何文件。")
        return 0 if consistent else 1

    # Health gate before writing: show dirty data and let the user decide.
    if not confirm_write_after_health(dirty_items):
        return 0
    log("")

    target = render_index(
        groups, len(entries), issues, duplicates, MODE_LABEL[effective_mode]
    )
    if effective_mode == "full" and index_path.is_file():
        shutil.copy2(index_path, backup_path)
        log(f"已备份旧索引：{backup_path}")

    try:
        atomic_write(index_path, target)
        write_state(state_path, entries, effective_mode)
    except OSError as exc:
        log(f"错误：写入失败 {exc}")
        return 1

    log(f"索引条目：{len(entries)} 条")
    log(f"已写入：{index_path}")
    log(f"状态清单：{state_path}")
    if issues:
        log("注意：存在未纳入索引的文档，修正 date 后重新运行即可。")
    if duplicates:
        log(f"注意：存在 {len(duplicates)} 组重复原文链接，已在索引中标记。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
