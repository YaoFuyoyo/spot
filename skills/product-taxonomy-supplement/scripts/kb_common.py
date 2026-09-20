#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""产品分类知识库脚本公共层：IO 编码、依赖检查、打开校验、写入预检。

被 query_kb.py 与 apply_kb.py 共用，两个脚本均通过
`sys.path.insert(0, dirname(abspath(__file__)))` 后 import 本模块。
"""

import os
import sys
import zipfile

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SKILL_ROOT))
# 平台权威数据源：tool-addprod 的 SQLite 知识库（与平台共用，随存档实时更新）
DEFAULT_DB = os.environ.get("ADDPROD_DB_PATH", "").strip() or os.path.join(PROJECT_ROOT, "data", "addprod.sqlite")
# xlsx 快照（离线场景 / 导出模板；不再随平台更新）
DEFAULT_KB = os.path.join(SKILL_ROOT, "references", "产品分类知识库.xlsx")

SHEET_STRUCT = "结构化"
SHEET_LEVEL = "层级"
STRUCT_HEADER = ["产品编号", "产品名称", "产品层级", "产品行业大类", "产品同义词"]
LEVEL_HEADER = ["一级编号", "一级名称", "二级编号", "二级名称",
                "三级编号", "三级名称", "四级编号", "四级名称", "行业大类"]

EXIT_OK, EXIT_USAGE, EXIT_DEP, EXIT_STRUCT, EXIT_PREFLIGHT = 0, 1, 2, 3, 4


def setup_io():
    """Windows 控制台默认编码可能是 GBK，强行切 UTF-8，避免中文输出/参数乱码。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def require_openpyxl():
    try:
        import openpyxl
        return openpyxl
    except ImportError:
        sys.stderr.write(
            "缺少依赖 openpyxl。请安装后再运行（建议用隔离环境，不要污染全局）：\n"
            "  <python> -m venv <venv> && <venv>/Scripts/pip install openpyxl\n"
            "  或：<python> -m pip install openpyxl\n"
        )
        sys.exit(EXIT_DEP)


def resolve_kb(path):
    if not path:
        path = DEFAULT_KB
    if not os.path.exists(path):
        sys.stderr.write(
            f"知识库不存在：{path}\n"
            f"可用 --kb 指定其他路径；技能自带副本位于 references/产品分类知识库.xlsx\n"
        )
        sys.exit(EXIT_USAGE)
    return path


def resolve_source(path):
    """解析数据源：缺省连平台 SQLite（与 tool-addprod 同源）；
    --kb 显式指定时按扩展名分流（.sqlite/.db/.sqlite3 -> sqlite，其他 -> xlsx）。
    返回 (path, kind)，kind ∈ {"sqlite", "xlsx"}。"""
    if not path:
        path = DEFAULT_DB
    if not os.path.exists(path):
        sys.stderr.write(
            f"知识库不存在：{path}\n"
            f"缺省数据源为平台 SQLite：{DEFAULT_DB}\n"
            f"也可用 --kb 显式指定 SQLite 库或 xlsx 快照（references/产品分类知识库.xlsx）。\n"
        )
        sys.exit(EXIT_USAGE)
    ext = os.path.splitext(path)[1].lower()
    return path, ("sqlite" if ext in (".sqlite", ".db", ".sqlite3") else "xlsx")


def load_rows_any(path, kind):
    """统一行读取：返回 [{code,name,level,industry,syn}]，按 int(编号) 升序。"""
    if kind == "sqlite":
        return load_rows_sqlite(path)
    return load_rows_xlsx(resolve_kb(path))


def load_rows_sqlite(path):
    import sqlite3
    d = sqlite3.connect(path)
    try:
        d.execute("PRAGMA query_only = ON")
        d.execute("PRAGMA busy_timeout = 10000")
        out = []
        for code, name, level, industry, syn in d.execute(
                "SELECT code, name, level, industry, synonyms FROM product "
                "ORDER BY CAST(code AS INTEGER)"):
            out.append({
                "code": str(code).strip(),
                "name": (name or "").strip(),
                "level": int(level) if level is not None else None,
                "industry": (industry or "").strip(),
                "syn": (syn or "").strip(),
            })
        return out
    finally:
        d.close()


def load_rows_xlsx(path):
    wb, ws_s, _ = open_kb(path, data_only=True, need_level=False)
    rows = []
    for r in ws_s.iter_rows(min_row=2, values_only=True):
        if r is None or r[0] is None:
            continue
        rows.append({
            "code": str(r[0]).strip(),
            "name": (str(r[1]).strip() if r[1] is not None else ""),
            "level": int(r[2]) if r[2] is not None else None,
            "industry": (str(r[3]).strip() if r[3] is not None else ""),
            "syn": (str(r[4]).strip() if r[4] is not None else ""),
        })
    return rows


def header_of(ws, ncol):
    vals = []
    for c in range(1, ncol + 1):
        v = ws.cell(1, c).value
        vals.append(str(v).strip() if v is not None else "")
    return vals


def open_kb(path, data_only=True, sheet_struct=SHEET_STRUCT, sheet_level=SHEET_LEVEL,
            need_level=True, check_header=True):
    openpyxl = require_openpyxl()
    path = resolve_kb(path)
    wb = openpyxl.load_workbook(path, data_only=data_only)

    missing = [s for s in [sheet_struct] + ([sheet_level] if need_level else [])
               if s not in wb.sheetnames]
    if missing:
        sys.stderr.write(
            f"工作表 {missing} 不存在。当前工作簿含：{wb.sheetnames}\n"
            f"如 sheet 命名不同，用 --sheet-struct / --sheet-level 指定。\n"
        )
        sys.exit(EXIT_STRUCT)

    ws_s = wb[sheet_struct]
    ws_l = wb[sheet_level] if need_level else None

    if check_header:
        actual = header_of(ws_s, len(STRUCT_HEADER))
        if actual != STRUCT_HEADER:
            sys.stderr.write(
                f"【{sheet_struct}】表头不符。\n  期望：{STRUCT_HEADER}\n  实际：{actual}\n"
                f"列结构不同会导致写入错位，已中止。确认无误可加 --ignore-header 跳过校验。\n"
            )
            sys.exit(EXIT_STRUCT)
        if ws_l is not None:
            actual_l = header_of(ws_l, len(LEVEL_HEADER))
            if actual_l != LEVEL_HEADER:
                sys.stderr.write(
                    f"【{sheet_level}】表头不符。\n  期望：{LEVEL_HEADER}\n  实际：{actual_l}\n"
                    f"确认无误可加 --ignore-header 跳过校验。\n"
                )
                sys.exit(EXIT_STRUCT)
    return wb, ws_s, ws_l


def preflight_write(path, force=False):
    """openpyxl 往返保存会丢失公式/图表/图片等，写入前先体检。"""
    risks = []
    try:
        z = zipfile.ZipFile(path)
        names = z.namelist()
    except Exception:
        return risks

    if any(n.startswith("xl/media") for n in names):
        risks.append("含图片，openpyxl 保存后可能丢失")
    if any("charts/" in n or n.endswith("chart.xml") for n in names):
        risks.append("含图表，openpyxl 不支持，保存后丢失")
    if any("pivot" in n.lower() for n in names):
        risks.append("含数据透视表，保存后丢失")
    if any("tables/" in n for n in names):
        risks.append("含表格对象(ListObject)，插入行可能破坏其范围")
    for n in names:
        if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"):
            try:
                s = z.read(n).decode("utf-8", "ignore")
            except Exception:
                continue
            if "<f>" in s or "<f " in s or "sharedFormula" in s:
                risks.append("含公式单元格，openpyxl 保存会清空公式")
                break

    if risks and not force:
        sys.stderr.write("写入预检未通过，已中止（未做任何改动）：\n")
        for r in risks:
            sys.stderr.write(f"  - {r}\n")
        sys.stderr.write("确认可承受后加 --force 继续；务必先备份。\n")
        sys.exit(EXIT_PREFLIGHT)
    return risks


def int_code(v):
    """编号转整数用于排序；非法值返回 None。"""
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None
