#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""产品分类知识库查询助手（只读，【结构化】/【层级】双 sheet）。

用法:
  python query_kb.py info                              知识库快照（路径/行数/排序校验）
  python query_kb.py check  <产品词> [--replace]       预检：存在性 / 冲突 / 噪声
  python query_kb.py find   <关键词> [--replace] [--limit N]
  python query_kb.py row    <产品编号>
  python query_kb.py path   <产品编号>                 打印 1→4 级归属链
  python query_kb.py children <产品编号> [--level N]   列出直接子级
  python query_kb.py next   <父级编号>                 下一个可用同级编码
  python query_kb.py contains <字符串>                 包含该子串的产品（噪声检查）
  python query_kb.py l1                                列出全部一级节点

选项:
  --kb PATH              知识库路径（默认 <skill>/references/产品分类知识库.xlsx）
  --limit N              输出条数上限（默认 30）
  --sheet-struct NAME    【结构化】sheet 名（默认 结构化）
  --sheet-level NAME     【层级】sheet 名（默认 层级）
  --ignore-header        跳过表头校验
  --json                 以 JSON 输出（便于其他程序消费）

退出码: 0 成功 / 1 用法或 IO 错误 / 2 缺少依赖 / 3 结构不符
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kb_common as K  # noqa: E402

K.setup_io()

# 维护手册「统一替换词规则」：组内词汇在全产品中可相互替换匹配
REPLACE_GROUPS = {
    "设备类": ["机械", "机器", "设备", "装备", "装置", "仪器", "器材", "器具", "器械"],
    "配件类": ["零件", "配件", "附件", "部件", "配套件", "零部件", "零配件"],
    "元件类": ["元件", "器件", "元器件"],
    "连接词": ["和", "与", "及"],
}


def load_rows(ws):
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
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


def syn_list(row):
    return [s for s in row["syn"].replace("；", ";").split(";") if s.strip()]


def replace_variants(word):
    out = {word}
    for group in REPLACE_GROUPS.values():
        for g in group:
            if g in word:
                for alt in group:
                    out.add(word.replace(g, alt))
    return sorted(out)


def emit(rows, args, header):
    if args.json:
        print(json.dumps({"count": len(rows), "rows": rows}, ensure_ascii=False, indent=2))
        return
    print(f"{header}：{len(rows)} 条" + (f"（显示前 {args.limit} 条）" if len(rows) > args.limit else ""))
    for r in rows[:args.limit]:
        print(f"  {r['code']:<10} | {r['name']:<34} | 层级{r['level']} | {r['industry']:<5} | 同义词: {r['syn'] or '-'}")


def cmd_info(args, ctx):
    ws_s, ws_l, rows = ctx["ws_s"], ctx["ws_l"], ctx["rows"]
    st = os.stat(ctx["path"])
    codes = [K.int_code(r["code"]) for r in rows]
    codes = [c for c in codes if c is not None]
    l4 = [K.int_code(ws_l.cell(r, 7).value) for r in range(2, ws_l.max_row + 1)]
    l4 = [c for c in l4 if c is not None]
    info = {
        "kb_path": ctx["path"],
        "size_mb": round(st.st_size / 1048576, 2),
        "modified": __import__("datetime").datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "sheets": ctx["wb"].sheetnames,
        "struct_rows": len(rows),
        "level_rows": len(l4),
        "struct_sorted_asc": all(codes[i] < codes[i + 1] for i in range(len(codes) - 1)),
        "level_sorted_asc": all(l4[i] < l4[i + 1] for i in range(len(l4) - 1)),
        "level1_count": sum(1 for r in rows if r["level"] == 1),
    }
    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return
    print("=== 知识库快照 ===")
    for k, v in info.items():
        print(f"  {k}: {v}")
    print("\n（references/知识库结构.md 中的行数为历史快照，以本命令实时结果为准）")


def cmd_check(args, ctx):
    rows = ctx["rows"]
    w = args.word
    exact = [r for r in rows if r["name"] == w]
    syn_hit = [r for r in rows if w in syn_list(r)]
    variants = [v for v in replace_variants(w) if v != w]
    vhit = [r for r in rows if r["name"] in variants or any(t in variants for t in syn_list(r))]
    contain = [r for r in rows if w in r["name"] and r["name"] != w]

    if args.json:
        print(json.dumps({"word": w, "exact_name": exact, "as_synonym": syn_hit,
                          "replace_variants": variants, "replace_hits": vhit,
                          "contained_in": contain}, ensure_ascii=False, indent=2))
        return

    print(f"=== 预检：{w} ===")
    print("1) 精确产品名命中：", "无" if not exact else "")
    for r in exact:
        print(f"   {r['code']} | {r['name']} | 层级{r['level']} | {r['industry']} | 同义词 {r['syn'] or '-'}")
    print("2) 作为同义词命中：", "无" if not syn_hit else "")
    for r in syn_hit:
        print(f"   {r['code']} | {r['name']} | 层级{r['level']} | {r['industry']}")
    print(f"3) 替换词等价写法（{len(variants)} 个）：{'、'.join(variants) if variants else '无'}")
    for r in vhit:
        print(f"   等价命中 -> {r['code']} | {r['name']} | 层级{r['level']} | {r['industry']}")
    print(f"4) 被更长产品名包含（子串噪声，共 {len(contain)} 个；库内按最长匹配处理，一般不阻断）：")
    for r in contain[:args.limit]:
        print(f"   {r['code']} | {r['name']} | 层级{r['level']} | {r['industry']}")
    if len(contain) > args.limit:
        print(f"   ... 其余 {len(contain) - args.limit} 个")
    print("\n结论提示：")
    print("  · 1)/2)/3) 任一命中 => 强信号，应作为老词同义词，不得新增。")
    print("  · 1)/2)/3) 均未命中 => 仍须做上下位判断（见 SKILL.md 步骤 3）：")
    print("    若该词是库中某节点下【多个子类的统称/上位词】，同样只能作同义词，不得新增。")


def cmd_find(args, ctx):
    kws = replace_variants(args.word) if args.replace else [args.word]
    hit = [r for r in ctx["rows"]
           if any(k in (r["name"] + ";" + r["syn"] + ";" + r["code"]) for k in kws)]
    emit(hit, args, f"关键词 {args.word}" + ("（含替换词展开）" if args.replace else ""))


def cmd_row(args, ctx):
    emit([r for r in ctx["rows"] if r["code"] == args.code], args, f"编号 {args.code}")


def cmd_path(args, ctx):
    idx = {r["code"]: r for r in ctx["rows"]}
    chain = []
    for ln in (2, 4, 6, 8):
        if len(args.code) < ln:
            break
        if args.code[:ln] in idx:
            chain.append(idx[args.code[:ln]])
    if args.json:
        print(json.dumps(chain, ensure_ascii=False, indent=2))
        return
    if not chain:
        print("未找到该编号的归属链")
        return
    print("归属链：")
    for r in chain:
        print(f"  {'  ' * (r['level'] - 1)}{r['code']:<10} | {r['name']:<30} | 层级{r['level']} | {r['industry']}")


def cmd_children(args, ctx):
    p, want_len = args.code, len(args.code) + 2
    hit = [r for r in ctx["rows"]
           if len(r["code"]) == want_len and r["code"].startswith(p)
           and (not args.level or r["level"] == args.level)]
    hit.sort(key=lambda r: K.int_code(r["code"]) or 0)
    emit(hit, args, f"{p} 的直接子级")


def cmd_next(args, ctx):
    p = args.code
    if len(p) >= 8:
        print("已是 4 级编码，无法再向下分配")
        return
    want_len = len(p) + 2
    nums = [K.int_code(r["code"][-2:]) for r in ctx["rows"]
            if len(r["code"]) == want_len and r["code"].startswith(p)]
    nums = [n for n in nums if n is not None]
    nxt = max(nums) + 1 if nums else 1
    if nxt > 99:
        print("该父级下已满 99 个子级，无法继续分配（每级上限 99）")
        return
    new_code = p + f"{nxt:02d}"
    parent = next((r for r in ctx["rows"] if r["code"] == p), None)
    if args.json:
        print(json.dumps({"parent": p, "sibling_count": len(nums), "next_code": new_code,
                          "level": want_len // 2, "industry": parent["industry"] if parent else None},
                         ensure_ascii=False))
        return
    print(f"父级 {p} 现有同级 {len(nums)} 个，下一个可用编码：{new_code}")
    print(f"层级：{want_len // 2} 级    行业大类沿用父级：{parent['industry'] if parent else '未知'}")


def cmd_contains(args, ctx):
    hit = [r for r in ctx["rows"] if args.word in r["name"] or args.word in r["syn"]]
    emit(hit, args, f"包含「{args.word}」的产品")


def cmd_l1(args, ctx):
    hit = sorted([r for r in ctx["rows"] if r["level"] == 1],
                 key=lambda r: K.int_code(r["code"]) or 0)
    explicit = any(a == "--limit" or a.startswith("--limit=") for a in sys.argv)
    saved, args.limit = args.limit, (args.limit if explicit else len(hit))
    emit(hit, args, "一级节点")
    args.limit = saved


GLOBAL_DEFAULTS = {
    "kb": None, "limit": 30, "sheet_struct": K.SHEET_STRUCT,
    "sheet_level": K.SHEET_LEVEL, "ignore_header": False, "json": False,
}


def main():
    # 公共选项同时挂在顶层与子命令上（子命令前后都能写）；
    # 用 SUPPRESS 避免子解析器默认值覆盖顶层已解析的值。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--kb", default=argparse.SUPPRESS)
    common.add_argument("--limit", type=int, default=argparse.SUPPRESS)
    common.add_argument("--sheet-struct", default=argparse.SUPPRESS)
    common.add_argument("--sheet-level", default=argparse.SUPPRESS)
    common.add_argument("--ignore-header", action="store_true", default=argparse.SUPPRESS)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)

    ap = argparse.ArgumentParser(description="产品分类知识库查询助手（只读）", parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("info", parents=[common])
    p = sub.add_parser("check", parents=[common]); p.add_argument("word"); p.add_argument("--replace", action="store_true")
    p = sub.add_parser("find", parents=[common]); p.add_argument("word"); p.add_argument("--replace", action="store_true")
    p = sub.add_parser("row", parents=[common]); p.add_argument("code")
    p = sub.add_parser("path", parents=[common]); p.add_argument("code")
    p = sub.add_parser("children", parents=[common]); p.add_argument("code"); p.add_argument("--level", type=int)
    p = sub.add_parser("next", parents=[common]); p.add_argument("code")
    p = sub.add_parser("contains", parents=[common]); p.add_argument("word")
    sub.add_parser("l1", parents=[common])

    args = ap.parse_args()
    for k, v in GLOBAL_DEFAULTS.items():
        if not hasattr(args, k):
            setattr(args, k, v)
    wb, ws_s, ws_l = K.open_kb(
        args.kb, data_only=True,
        sheet_struct=args.sheet_struct, sheet_level=args.sheet_level,
        need_level=True, check_header=not args.ignore_header)
    ctx = {"wb": wb, "ws_s": ws_s, "ws_l": ws_l, "rows": load_rows(ws_s), "path": K.resolve_kb(args.kb)}

    {"info": cmd_info, "check": cmd_check, "find": cmd_find, "row": cmd_row, "path": cmd_path,
     "children": cmd_children, "next": cmd_next, "contains": cmd_contains, "l1": cmd_l1}[args.cmd](args, ctx)


if __name__ == "__main__":
    main()
