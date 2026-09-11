#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把产品补充结果写入知识库（【结构化】+【层级】双 sheet 同步）。

两个 sheet 均按 int(编号) 严格升序排列：
  【结构化】按 int(产品编号)   —— 插入位置 = 首个编号大于新编号的行
  【层级】  按 int(四级编号)   —— 插入位置 = 首个四级编号大于新编号的行
因此必须"按编号顺序插入"，不能追加到末尾。

用法:
  python apply_kb.py --spec spec.json [--dry-run] [--force] [--no-backup]
  python apply_kb.py --syn 3503=工程机械 [--dry-run]
  python apply_kb.py --add "35031001|盾构机|4|C35|全断面隧道掘进机" [--dry-run]

spec.json 格式（推荐，中文场景优先用文件传参，避免命令行编码问题）:
{
  "synonyms": [{"code": "3503", "syn": "工程机械"}],
  "add": [
    {"code": "350310", "name": "隧道掘进机械", "level": 3, "industry": "C35", "syn": ""},
    {"code": "35031001", "name": "盾构机", "level": 4, "industry": "C35", "syn": "全断面隧道掘进机"}
  ]
}

选项:
  --kb PATH / --sheet-struct / --sheet-level / --ignore-header
  --dry-run       只打印计划，不写入
  --force         跳过写入预检（知识库含公式/图表/图片时）
  --no-backup     不生成备份
  --backup-dir DIR 备份目录（默认与知识库同目录）
  --json          以 JSON 输出变更摘要

退出码: 0 成功 / 1 用法或 IO 错误 / 2 缺少依赖 / 3 结构不符 / 4 写入预检未通过
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kb_common as K  # noqa: E402

K.setup_io()

STRUCT_COLS = 5
LEVEL_COLS = 9
LEVEL_NAME_COL = {1: 2, 2: 4, 3: 6, 4: 8}
LEVEL_CODE_COL = {1: 1, 2: 3, 3: 5, 4: 7}


def fmt_node(name, syn):
    """还原【层级】sheet 的级名称写法：主名：同义词1；同义词2"""
    syns = [s.strip() for s in (syn or "").replace("；", ";").split(";") if s.strip()]
    return name + ("：" + "；".join(syns) if syns else "")


def load_nodes(ws):
    nodes = {}
    for r in range(2, ws.max_row + 1):
        code = ws.cell(r, 1).value
        if code is None:
            continue
        nodes[str(code).strip()] = {
            "row": r,
            "name": ws.cell(r, 2).value or "",
            "level": int(ws.cell(r, 3).value or 0),
            "industry": ws.cell(r, 4).value,
            "syn": ws.cell(r, 5).value,
        }
    return nodes


def find_insert_row(ws, key_col, new_code, last_row):
    n = K.int_code(new_code)
    best = last_row + 1
    for r in range(2, last_row + 1):
        v = K.int_code(ws.cell(r, key_col).value)
        if v is None:
            continue
        if n is not None and v > n:
            return r
    return best


def copy_row_style(ws, src_row, dst_row, ncols):
    for c in range(1, ncols + 1):
        ws.cell(dst_row, c)._style = ws.cell(src_row, c)._style


def write_struct_row(ws, row, code, name, level, industry, syn):
    ws.cell(row, 1).value = str(code)
    ws.cell(row, 2).value = name
    ws.cell(row, 3).value = int(level)
    ws.cell(row, 4).value = industry
    ws.cell(row, 5).value = (syn or "").strip() or None


def build_spec(args):
    spec = {"synonyms": [], "add": []}
    if args.spec:
        if not os.path.exists(args.spec):
            sys.stderr.write(f"spec 文件不存在：{args.spec}\n")
            sys.exit(K.EXIT_USAGE)
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        spec.setdefault("synonyms", [])
        spec.setdefault("add", [])
    for s in args.syn:
        code, sep, syn = s.partition("=")
        if not sep:
            sys.stderr.write(f"--syn 格式应为 CODE=同义词，收到：{s}\n")
            sys.exit(K.EXIT_USAGE)
        spec["synonyms"].append({"code": code.strip(), "syn": syn.strip()})
    for a in args.add:
        parts = [p.strip() for p in a.split("|")]
        if len(parts) != 5:
            sys.stderr.write(f"--add 格式应为 CODE|NAME|LEVEL|INDUSTRY|SYN，收到：{a}\n"
                             f"产品名含 | 时请改用 --spec spec.json\n")
            sys.exit(K.EXIT_USAGE)
        try:
            level = int(parts[2])
        except ValueError:
            sys.stderr.write(f"--add 层级必须为整数，收到：{parts[2]}\n")
            sys.exit(K.EXIT_USAGE)
        spec["add"].append({"code": parts[0], "name": parts[1], "level": level,
                            "industry": parts[3], "syn": parts[4]})
    return spec


def main():
    ap = argparse.ArgumentParser(description="产品分类知识库落表")
    ap.add_argument("--kb", default=None)
    ap.add_argument("--spec")
    ap.add_argument("--syn", action="append", default=[], metavar="CODE=同义词")
    ap.add_argument("--add", action="append", default=[], metavar="CODE|NAME|LEVEL|INDUSTRY|SYN")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="跳过写入预检")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--backup-dir", default=None)
    ap.add_argument("--sheet-struct", default=K.SHEET_STRUCT)
    ap.add_argument("--sheet-level", default=K.SHEET_LEVEL)
    ap.add_argument("--ignore-header", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    spec = build_spec(args)
    if not spec["synonyms"] and not spec["add"]:
        sys.stderr.write("没有待写入的变更\n")
        sys.exit(K.EXIT_USAGE)

    path = K.resolve_kb(args.kb)
    if not args.dry_run:
        K.preflight_write(path, force=args.force)

    wb, ws_s, ws_l = K.open_kb(
        path, data_only=False,
        sheet_struct=args.sheet_struct, sheet_level=args.sheet_level,
        need_level=True, check_header=not args.ignore_header)
    nodes = load_nodes(ws_s)
    summary = {"synonyms": [], "add": [], "dry_run": args.dry_run}

    # ---------- 1) 同义词挂入（先做，保证后续新增行的祖先名称已含新同义词） ----------
    for item in spec["synonyms"]:
        code, syn = str(item["code"]).strip(), (item.get("syn") or "").strip()
        if code not in nodes:
            sys.stderr.write(f"[跳过] 编号 {code} 不存在\n")
            continue
        nd = nodes[code]
        cur = [s.strip() for s in (nd["syn"] or "").replace("；", ";").split(";") if s.strip()]
        if syn in cur:
            sys.stderr.write(f"[跳过] {code} 已含同义词「{syn}」\n")
            continue
        cur.append(syn)
        new_syn = "；".join(cur)
        nd["syn"] = new_syn
        if not args.dry_run:
            ws_s.cell(nd["row"], 5).value = new_syn

        cc, nc = LEVEL_CODE_COL[nd["level"]], LEVEL_NAME_COL[nd["level"]]
        n_hit = 0
        for r in range(2, ws_l.max_row + 1):
            if str(ws_l.cell(r, cc).value or "").strip() == code:
                n_hit += 1
                if not args.dry_run:
                    ws_l.cell(r, nc).value = fmt_node(nd["name"], new_syn)
        summary["synonyms"].append({"code": code, "name": nd["name"], "new_syn": new_syn,
                                    "level_rows_updated": n_hit})

    # ---------- 2) 新增节点（按编码升序，保证插入位置递推正确） ----------
    for item in sorted(spec["add"], key=lambda x: K.int_code(str(x["code"])) or 0):
        code = str(item["code"]).strip()
        if code in nodes:
            sys.stderr.write(f"[跳过] 编号 {code} 已存在：{nodes[code]['name']}\n")
            continue
        lvl = int(item["level"])
        if len(code) != lvl * 2:
            sys.stderr.write(f"[跳过] {code} 长度与层级 {lvl} 不符（应为 {lvl * 2} 位）\n")
            continue
        parent = code[:-2]
        if parent and parent not in nodes:
            sys.stderr.write(f"[跳过] {code} 的父级 {parent} 不存在\n")
            continue
        industry = item["industry"] or (nodes[parent]["industry"] if parent else None)
        syn = (item.get("syn") or "").strip()

        pos = find_insert_row(ws_s, 1, code, ws_s.max_row)
        before = ws_s.cell(pos - 1, 1).value if pos > 2 else None
        after = ws_s.cell(pos, 1).value
        rec = {"code": code, "name": item["name"], "level": lvl, "industry": industry,
               "syn": syn or None, "struct_row": pos, "before": before, "after": after,
               "level_row": None}

        if not args.dry_run:
            ws_s.insert_rows(pos)
            copy_row_style(ws_s, pos + 1 if pos + 1 <= ws_s.max_row else pos - 1, pos, STRUCT_COLS)
            write_struct_row(ws_s, pos, code, item["name"], lvl, industry, syn)
        nodes[code] = {"row": pos, "name": item["name"], "level": lvl,
                       "industry": industry, "syn": syn or None}

        if lvl == 4:
            lpos = find_insert_row(ws_l, 7, code, ws_l.max_row)
            rec["level_row"] = lpos
            if not args.dry_run:
                ws_l.insert_rows(lpos)
                copy_row_style(ws_l, lpos + 1 if lpos + 1 <= ws_l.max_row else lpos - 1,
                               lpos, LEVEL_COLS)
                for ln in (1, 2, 3, 4):
                    c = code[:ln * 2]
                    ws_l.cell(lpos, LEVEL_CODE_COL[ln]).value = c
                    ws_l.cell(lpos, LEVEL_NAME_COL[ln]).value = fmt_node(
                        nodes[c]["name"], nodes[c]["syn"])
                ws_l.cell(lpos, 9).value = industry
        summary["add"].append(rec)

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if args.dry_run:
            return
    else:
        print("=== 落表计划 ===" if args.dry_run else "=== 已写入 ===")
        for s in summary["synonyms"]:
            print(f"  同义词 {s['code']} {s['name']} -> {s['new_syn']}"
                  f"（同步【层级】{s['level_rows_updated']} 行）")
        for a in summary["add"]:
            print(f"  新增 {a['code']} {a['name']} L{a['level']} {a['industry']}"
                  f" -> 【结构化】第 {a['struct_row']} 行（前 {a['before']} / 后 {a['after']}）")
            if a["level_row"]:
                print(f"    ├ 插入【层级】第 {a['level_row']} 行（完整 4 级路径）")
        if args.dry_run:
            print("\n[dry-run] 未写入任何改动。去掉 --dry-run 执行写入。")
            return

    if not args.no_backup:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base = os.path.basename(path)
        bak_name = f"{os.path.splitext(base)[0]}.bak_{stamp}.xlsx"
        bak_dir = args.backup_dir or os.path.dirname(os.path.abspath(path))
        os.makedirs(bak_dir, exist_ok=True)
        bak = os.path.join(bak_dir, bak_name)
        shutil.copy2(path, bak)
        summary["backup"] = bak
        if not args.json:
            print(f"\n备份：{bak}")
    wb.save(path)
    summary["saved"] = path
    if not args.json:
        print(f"已保存：{path}")
    elif args.json:
        print(json.dumps({"backup": summary.get("backup"), "saved": path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
