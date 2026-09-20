# -*- coding: utf-8 -*-
"""
产品上下游关系 Excel 生成器
==========================
入参 : 产品编号(如 3923) + 可选数据文件/接口配置
输出 : {产品编号}{产品名称}.xlsx —— 单 sheet、12 列、微软雅黑10pt、表头加粗

设计原则（面向打包分享与生产使用）
--------------------------------
* 依赖的线下数据文件随 skill 一起分发，位于 skill 根目录下的 references/：
    references/产品分类知识库.xlsx   产品编码/名称/层级/父级
    references/产业链图谱.xlsx       产业链节点结构
  脚本按「自身文件位置」解析 skill 根目录，因此拷贝到任意机器/目录均可直接运行。
* 不含任何产品系列的内置业务数据。未提供的文件 / 未接入或调用失败的接口
  => 该来源产出 0 条边（视为无此部分数据），不回退到任何默认或示例数据。
* 各来源本身均无 KB 产品码系统，KB 编码由大模型语义对齐得到（设计内噪声）。

用法
----
python scripts/generate_updown.py <产品编号> [--edges 边数据json] [--kb KB路径]
                                  [--graph 图谱路径] [--kbmap 映射json]
                                  [--gongyi 工艺常识Excel] [--head-ent 头部企业]
                                  [--out 输出路径]
"""
import os, sys, json, argparse
import openpyxl

# ============ skill 根目录（按脚本位置解析，保证打包后可用） ============
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT  = os.path.dirname(SCRIPTS_DIR)
REF_DIR       = os.path.join(SKILL_ROOT, "references")
DEFAULT_KB     = os.path.join(REF_DIR, "产品分类知识库.xlsx")
DEFAULT_GRAPH  = os.path.join(REF_DIR, "产业链图谱.xlsx")

# ============ 常量：列 / 等级 / 来源 ============
HEADER = ["关系ID","上游编号","上游名称","上游层级","下游编号","下游名称",
          "下游层级","关系类型","关系强度","建边层级","依据来源","置信度"]

CONF_RANK = {"高":3, "中":2, "低":1}
STR_RANK  = {"强":3, "中":2, "弱":1}
# 关系类型优先级(合并时并列取高者)
TYPE_PRIO = {"物料投入":5, "装备支撑":4, "服务支撑":3, "联产副产":2, "相互替代":1}
# 需双向成边的关系类型：一个关系落两条边(A->B 与 B->A)
BIDIRECTIONAL_TYPES = {"相互替代"}

# 事实来源 -> 置信度（来源可扩展：在此登记新来源即可）
SRC_CONF  = {"税票商品":"高", "上市信息":"中", "工艺常识":"中", "产业图谱":"低", "舆情资讯":"低"}
# 同一置信度内的稳定排序(保证输出可复现)
SRC_ORDER = {"税票商品":0, "上市信息":1, "工艺常识":2, "产业图谱":3, "舆情资讯":4}

SEP = ","          # 多源依据来源的拼接分隔符


def pad(code):
    """编号补零到 8 位：2625 -> 26250000"""
    s = str(int(code)); return s + "0"*(8-len(s))


# ============ 1. 加载产品分类知识库 ============
def load_kb(kb_path):
    """返回 code2name, code2level, parent。
    注意：KB『层级』表同一编码会因下级展开在多行重复出现，需按 dict 覆盖去重。"""
    if not os.path.exists(kb_path):
        raise FileNotFoundError(f"未找到产品分类知识库: {kb_path}")
    ws = openpyxl.load_workbook(kb_path, read_only=True, data_only=True)["层级"]
    code2name, code2level, parent = {}, {}, {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        c = list(r) + [None]*8
        for lv in range(1, 5):
            code = c[2*(lv-1)]; name = c[2*(lv-1)+1]
            if code is None or str(code).strip() == "": continue
            # KB 编码为定宽零补齐：L1=2 / L2=4 / L3=6 / L4=8 位。
            # 必须经 int 再 zfill 还原前导零，绝不能用 str(int(code)) 裸用——
            # 否则 '0101' 会变成 '101'，既丢失层级宽度又被误判为"位数不固定"。
            cc = str(int(code)).zfill(2*lv)
            code2name[cc] = name
            code2level[cc] = lv
            if lv > 1:
                p = c[2*(lv-2)]
                if p is not None and str(p).strip() != "":
                    parent[cc] = str(int(p)).zfill(2*(lv-1))
    return code2name, code2level, parent


# ============ 2. 图谱节点名 -> KB 码 自动映射 ============
def build_name_index(code2name):
    """KB 产品名 -> 编码 索引（同名保留首个）。"""
    idx = {}
    for c, n in code2name.items():
        if n is None: continue
        nn = str(n).strip()
        if nn and nn not in idx:
            idx[nn] = c
    return idx


def map_node(node_name, name2code, override=None, default_rt="物料投入"):
    """图谱节点名 -> (KB编码, 关系类型)。
    --kbmap 支持两种写法（后者可逐节点指定关系类型，避免设备/软件被误标为物料投入）：
        {"半导体材料": "262505"}
        {"光刻设备": {"kb": "35420201", "rt": "装备支撑"}}
    优先级：大模型对齐结果 > KB 完全同名精确匹配。
    不做子串模糊匹配：模糊对齐由大模型完成，脚本不做猜测匹配。"""
    nm = str(node_name).strip()
    if not nm: return None, None
    if override and nm in override:
        v = override[nm]
        if isinstance(v, dict):
            return v.get("kb"), v.get("rt", default_rt)
        return v, default_rt
    return name2code.get(nm), default_rt


# ============ 3. 接口占位（未接入 / 调用失败 => 无数据） ============
# 4 个 API 由同一套 amardata MCP 对接，工具编码见 SKILL.md《API 对接表》。
IFACE = {
    # R1401 供应链交易数据统计
    "R1401":   None,  # 入参:coreEntName企业名称, tradeCloseness交易紧密度
                      # -> [entName交易方名称, entChainName交易方所属产业链, roleType交易角色]
                      # 限制: tradeCloseness=[一级|二级]; entChainName 非空
                      # roleType 枚举: 1-上游(交易方为核心企业的上游供应方), 2-下游(交易方为下游客户)
    # R1521V2 企业主营产品（事实来源，用于上下游企业产品）
    "R1521V2": None,  # 入参:entName企业名称 -> product企业产品
    # R4G04V2 上市公司基本信息
    "R4G04V2": None,  # 入参:name企业名称
                      # -> MAINPRODUCTS主要产品, MAINBUSIN主营业务, COMPPROFILE公司简介
    # R331 舆情全文检索内部接口
    "R331":    None,  # 入参:keyword产品词 -> [title文章标题, TEXT文章内容]
}

# 各来源对应的 MCP 取数工具，用于「未接线」时提示调用方如何去取数
TOOL_HINT = {
    "税票商品": "MCP enterprise_trade_analysis(R1401) + enterprise_industry_chain(R1521V2)",
    "上市信息": "MCP enterprise_listed_info(R4G04V2)",
    "舆情资讯": "MCP enterprise_sentiment(R331)",
}

def empty_hint(src, why):
    """某来源产出 0 条时的提示语：说明原因，并给出补数方式。
    注意：IFACE 为 None 是『未接线』的设计，与 MCP 是否连通无关——脚本本身不负责调 MCP。"""
    return [], f"{src}：0 条（{why}；如需此来源请用 {TOOL_HINT[src]} 取数并语义对齐 KB 码后经 --edges 注入）"

def call_iface(iface, **kw):
    """注意：首参 iface 是接口代号(R1401/R1521V2/R4G04V2/R331)，
    不可命名为 name——R1521V2、R4G04V2 的业务入参本身就叫 name，会撞名冲突。"""
    fn = IFACE.get(iface)
    if fn is None:
        return None                      # 未接入 -> 无数据
    try:
        return fn(**kw)
    except Exception:                    # 调用失败 -> 当作无数据
        return None


# ============ 4. 各来源采集 ============
def collect_shuipiao(product, head_ent=None):
    """税票商品(高)：R1401 取供应链交易对手方 -> R1521V2 取该企业主营产品
    -> 上游交易方的产品作上游、下游交易方的产品作下游 -> 语义对齐 KB 码。
    R1401 筛：tradeCloseness=一级/二级 且 entChainName 非空。
    定向依赖 R1401 的 roleType 交易角色（1=上游、2=下游；缺则跳过，不臆断方向）。"""
    if not head_ent:
        return empty_hint("税票商品", "未指定 --head-ent")
    peers = call_iface("R1401", coreEntName=head_ent, tradeCloseness="一级")
    if not peers:
        return empty_hint("税票商品", "IFACE R1401 未接线/无数据")
    out, no_role = [], 0
    for p in peers:
        if not p.get("entChainName"):
            continue                              # 所属产业链为空 -> 丢弃
        ent = p.get("entName") or p.get("ent")
        if not ent: continue
        goods = call_iface("R1521V2", entName=ent)
        if not goods: continue
        role = p.get("roleType")                  # 1-上游 / 2-下游
        if role is None:
            no_role += 1; continue                # 无交易角色无法定向，跳过
        for g in goods:                  # g: {"kb":KB码,...} 企业产品由大模型语义对齐到 KB 码
            kb = g.get("kb")
            if not kb: continue
            if int(role) == 1:                    # 交易方处在上游 -> 其产品作为上游
                out.append(dict(up=kb, dn=product, rt=g.get("rt","物料投入"), st=g.get("st","中")))
            else:                                 # 交易方处在下游 -> 其产品作为下游
                out.append(dict(up=product, dn=kb, rt=g.get("rt","物料投入"), st=g.get("st","中")))
    out = [dict(e, src="税票商品", conf=SRC_CONF["税票商品"]) for e in out]
    msg = f"税票商品：{len(out)} 条"
    if no_role: msg += f"（{no_role} 个交易方缺交易角色，已跳过）"
    return out, msg


def collect_shangshi(product, head_ent=None):
    """上市信息(中)：R4G04V2 上市公司基本信息
    （MAINPRODUCTS 主要产品 / MAINBUSIN 主营业务 / COMPPROFILE 公司简介）
    -> 由大模型从三段文本中解析上游(采购/成本构成)与下游(应用领域) -> 语义对齐 KB 码。"""
    if not head_ent:
        return empty_hint("上市信息", "未指定 --head-ent")
    prods = call_iface("R4G04V2", name=head_ent)
    if not prods:
        return empty_hint("上市信息", "IFACE R4G04V2 未接线/无数据")
    out = []
    for p in prods:                      # p: {"kb":KB码,"side":"up"/"dn",...}
        kb = p.get("kb")
        if not kb: continue
        if p.get("side") == "up":
            out.append(dict(up=kb, dn=product, rt=p.get("rt","物料投入"), st=p.get("st","中")))
        else:
            out.append(dict(up=product, dn=kb, rt=p.get("rt","物料投入"), st=p.get("st","中")))
    out = [dict(e, src="上市信息", conf=SRC_CONF["上市信息"]) for e in out]
    return out, f"上市信息：{len(out)} 条"


def collect_yuqing(product, product_name):
    """舆情资讯(低)：R331 以 keyword=产品名称 全文检索舆情资讯
    -> 由大模型分析文章标题与正文得出上下游 -> 语义对齐 KB 码。"""
    news = call_iface("R331", keyword=product_name)
    if not news:
        return empty_hint("舆情资讯", "IFACE R331 未接线/无数据")
    out = []
    for n in news:                       # n: {"kb":KB码,"side":"up"/"dn","rt":...,"st":...}
        kb = n.get("kb")
        if not kb: continue
        if n.get("side") == "up":
            out.append(dict(up=kb, dn=product, rt=n.get("rt","物料投入"), st=n.get("st","中")))
        else:
            out.append(dict(up=product, dn=kb, rt=n.get("rt","物料投入"), st=n.get("st","中")))
    out = [dict(e, src="舆情资讯", conf=SRC_CONF["舆情资讯"]) for e in out]
    return out, f"舆情资讯：{len(out)} 条"


def collect_edges(path):
    """读取大模型产出的边数据 json，直接注入管线，不落中间 Excel。
    json 为数组，每项: {"up":上游KB码, "dn":下游KB码, "rt":关系类型,
                        "st":关系强度, "src":来源名, "conf":置信度(可选)}
    来源名须已在 SRC_CONF 登记；conf 省略时按该来源默认置信度。"""
    if not path:
        return [], "【未配置】未提供 --edges 边数据"
    s = str(path).strip()
    try:
        # 直接传 JSON 字符串（推荐，不落文件）；也可传已有 json 文件路径
        if s.startswith("["):
            data = json.loads(s)
        else:
            if not os.path.exists(s):
                return [], f"【未找到】边数据文件：{s}"
            data = json.load(open(s, encoding="utf-8"))
    except Exception as e:
        return [], f"【解析失败】边数据：{e}"
    out, bad_src = [], []
    for it in data:
        src = str(it.get("src", "")).strip()
        if src not in SRC_CONF:
            if src not in bad_src: bad_src.append(src)
            continue
        if not it.get("up") or not it.get("dn"): continue
        out.append(dict(up=str(it["up"]), dn=str(it["dn"]),
                        rt=str(it.get("rt", "物料投入")), st=str(it.get("st", "中")),
                        src=src, conf=it.get("conf") or SRC_CONF[src]))
    msg = f"边数据文件：{len(out)} 条"
    if bad_src: msg += f"（未登记来源已跳过：{', '.join(bad_src)}）"
    return out, msg


def collect_gongyi(product, gongyi_path):
    """工艺常识(中)：读取人工沉淀的关系文件(与输出同构的12列表)。未提供文件=>0条。"""
    if not gongyi_path or not os.path.exists(gongyi_path):
        return [], "【未配置】工艺常识文件未提供，返回空"
    try:
        wb = openpyxl.load_workbook(gongyi_path, read_only=True, data_only=True)
        ws = None
        for s in wb.sheetnames:
            if "总表" in s or "关系" in s: ws = wb[s]; break
        if ws is None: ws = wb[wb.sheetnames[0]]
        rows = list(ws.iter_rows(values_only=True))
        ci = {str(h): i for i, h in enumerate(rows[0])}
        need = ["上游编号","下游编号","关系类型","关系强度"]
        if any(n not in ci for n in need):
            return [], f"【格式不符】工艺常识文件缺少必要列 {need}"
        out = []
        for r in rows[1:]:
            if not r[0]: continue
            try:
                up = str(int(r[ci["上游编号"]])); dn = str(int(r[ci["下游编号"]]))
            except Exception:
                continue
            out.append(dict(up=up, dn=dn, rt=str(r[ci["关系类型"]]), st=str(r[ci["关系强度"]])))
        out = [dict(e, src="工艺常识", conf=SRC_CONF["工艺常识"]) for e in out]
        return out, f"工艺常识：{len(out)} 条(来自 {os.path.basename(gongyi_path)})"
    except Exception as e:
        return [], f"【读取失败】工艺常识：{e}"


def collect_chanye(product, product_name, graph_path, code2name, kbmap_path=None,
                   default_rt="物料投入"):
    """产业图谱(低)：读产业链图谱.xlsx，按链名定位产品所属链；
    节点所属环节=1 取上游、=3 取下游；节点名经『名称自动匹配』对齐 KB 码（可用 --kbmap 手工修正）。

    关系类型默认 default_rt(--graph-rt)，但**不应一律按物料投入**：设备/产线->装备支撑、
    检测/设计/EDA 等软件->服务支撑。请通过 --kbmap 逐节点给出 rt，或 --graph-rt 调整默认值。"""
    if not graph_path or not os.path.exists(graph_path):
        return [], "【未配置】产业链图谱文件未提供，产业图谱返回空"
    override = None
    if kbmap_path:
        s = str(kbmap_path).strip()
        try:
            # 直接传 JSON 字符串（推荐，不落文件）；也可传已有 json 文件路径
            if s.startswith("{"):
                override = json.loads(s)
            else:
                if not os.path.exists(s):
                    return [], f"【未找到】映射文件：{s}"
                override = json.load(open(s, encoding="utf-8"))
        except Exception as e:
            return [], f"【解析失败】图谱映射：{e}"
    try:
        name2code = build_name_index(code2name)
        wb = openpyxl.load_workbook(graph_path, read_only=True)
        ws = wb[wb.sheetnames[0]]
        rows = list(ws.iter_rows(values_only=True))
        hdr = [str(x) for x in rows[0]]
        def col(name, default):
            return hdr.index(name) if name in hdr else default
        c_chain, c_node, c_link = col("产业链名称",1), col("节点名称",3), col("节点所属环节",7)
        c_nid, c_pid = col("节点编号",2), col("上级节点编号",4)
        chains = set()
        for r in rows[1:]:
            cn = str(r[c_chain]) if c_chain < len(r) else ""
            if cn and (product_name in cn or cn in product_name):
                chains.add(cn)
        if not chains:
            return [], f"【未命中】图谱中无匹配「{product_name}」的产业链"
        # 只取叶子节点(无下级者)作为产品，排除"原材料/零部件/应用领域"等目录节点
        parents = set()
        for r in rows[1:]:
            if str(r[c_chain]) in chains:
                pv = r[c_pid] if c_pid < len(r) else None
                if pv is not None and str(pv).strip() != "":
                    parents.add(str(pv).strip())
        ups, dns, mapped, unmapped, skipped = [], [], [], [], []
        for r in rows[1:]:
            if str(r[c_chain]) not in chains: continue
            nid = str(r[c_nid]).strip() if c_nid < len(r) else ""
            if nid and nid in parents:
                continue                                   # 目录节点跳过
            nm = str(r[c_node]) if c_node < len(r) else ""
            link = str(r[c_link]) if c_link < len(r) else ""
            kb, rt = map_node(nm, name2code, override, default_rt)
            if not kb:
                if nm and nm not in unmapped: unmapped.append(nm)
                continue
            if rt not in TYPE_PRIO:                # 关系类型未登记 -> 回退默认，避免脏值入库
                rt = default_rt
            # 排除自环与"映射到产品自身子树"的节点：父->子属于分类关系，不是上下游
            if kb == product or kb.startswith(product):
                if nm not in skipped: skipped.append(nm)
                continue
            mapped.append(f"{nm}->{kb}({rt})")
            if link == "1": ups.append((kb, rt))
            elif link == "3": dns.append((kb, rt))
        out = [dict(up=u, dn=product, rt=rt, st="中") for u, rt in ups]
        out += [dict(up=product, dn=d, rt=rt, st="中") for d, rt in dns]
        out = [dict(e, src="产业图谱", conf=SRC_CONF["产业图谱"]) for e in out]
        msg = f"产业图谱：上游{len(ups)} 下游{len(dns)} 共{len(out)}条"
        if mapped:   msg += f"\n      已映射: {', '.join(mapped[:12])}" + (" ..." if len(mapped)>12 else "")
        if unmapped: msg += f"\n      未映射(已跳过): {', '.join(unmapped[:12])}" + (" ..." if len(unmapped)>12 else "")
        if skipped:  msg += f"\n      自环已排除: {', '.join(skipped[:8])}"
        return out, msg
    except Exception as e:
        return [], f"【解析失败】产业图谱：{e}"


# ============ 4b. 双向关系展开 ============
def expand_bidirectional(edges):
    """『相互替代』属横向关系，一个关系需成对落边：A→B 与 B→A 各一条。
    若来源只给了一条，自动补全反向边（保持同来源/同类型/同强度）。"""
    out = list(edges)
    for e in edges:
        if e.get("rt") in BIDIRECTIONAL_TYPES:
            if not any(x["up"] == e["dn"] and x["dn"] == e["up"] for x in edges):
                out.append(dict(e, up=e["dn"], dn=e["up"]))
    return out


# ============ 5. 方案A 合并 ============
def merge(edges, code2level):
    """唯一键=(上游编号,下游编号)；依据来源 SEP 拼接(置信降序)；
    置信度取最高档；关系强度取最强；建边层级=min(上下游层级)。"""
    merged = {}
    for e in edges:
        k = (e["up"], e["dn"])
        rec = merged.setdefault(k, dict(up=e["up"], dn=e["dn"], sources=[], types=[],
                                        strengths=[], confs=[],
                                        upl=code2level.get(e["up"]), dnl=code2level.get(e["dn"])))
        rec["sources"].append(e["src"]); rec["types"].append(e["rt"])
        rec["strengths"].append(e["st"]); rec["confs"].append(e["conf"])
    rows = []
    for k, rec in merged.items():
        best_conf = max(rec["confs"], key=lambda c: CONF_RANK[c])
        idxs = [i for i, c in enumerate(rec["confs"]) if c == best_conf]
        best_type = max((rec["types"][i] for i in idxs), key=lambda t: TYPE_PRIO.get(t, 0))
        best_st   = max(rec["strengths"], key=lambda s: STR_RANK.get(s, 0))
        bl = min(rec["upl"], rec["dnl"])
        uniq = sorted(set(rec["sources"]), key=lambda s: (-CONF_RANK[SRC_CONF[s]], SRC_ORDER[s]))
        rows.append(dict(rid="R" + pad(rec["up"]) + pad(rec["dn"]),
                         up=rec["up"], upl=rec["upl"],
                         dn=rec["dn"], dnl=rec["dnl"],
                         rt=best_type, st=best_st, bl=bl,
                         src=SEP.join(uniq), conf=best_conf))
    return rows


# ============ 6. 剔除冗余继承边 ============
def weaken(s, hops):
    """关系强度随继承逐级递减：祖父强->父中->子弱->孙停(>=3跳返回None=不可继承)。"""
    order = {"强":0, "中":1, "弱":2}; inv = {0:"强", 1:"中", 2:"弱"}
    if s not in order: return s
    cur = order[s] + hops
    return None if cur > 2 else inv[cur]


def remove_inherited(rows, parent):
    """有父级不存子级：下游节点若存在祖先已存同上游边，且继承后强度有效(<=孙级)，
    则该边可由继承现算得到，不冗余存储。
    注意：必须校验 weaken(...) is not None，否则会把『祖先太远、实际继承不到』的边误删。"""
    stored = {(r["up"], r["dn"]): r["st"] for r in rows}
    keep = []
    for r in rows:
        up, dn = r["up"], r["dn"]
        redundant = False
        if dn in parent:
            cur, hops, seen = dn, 0, set()
            while cur in parent and parent[cur] is not None and cur not in seen:
                anc = parent[cur]; hops += 1; seen.add(cur)
                if (up, anc) in stored:
                    if weaken(stored[(up, anc)], hops) is not None:
                        redundant = True; break
                cur = anc
        if not redundant:
            keep.append(r)
    return keep


# ============ 6b. 输出排序 ============
def row_group(r, product):
    """0=入参产品系列作为下游；1=入参产品系列作为上游；2=非入参系列(来源顺带挖出的关系)"""
    if r["dn"].startswith(product): return 0
    if r["up"].startswith(product): return 1
    return 2


def sort_rows(rows, product):
    """三段排序：
    组0(系列作下游): 下游编号升序 -> 上游编号升序
    组1(系列作上游): 上游编号升序 -> 下游编号升序
    组2(非系列相关): 上游编号升序 -> 下游编号升序
    （KB 编码为定宽零补齐，故「以输入编号为前缀」即等于该产品完整子树，含 L1/L2/L3/L4 任意层级输入）"""
    def key(r):
        g = row_group(r, product)
        up, dn = int(r["up"]), int(r["dn"])
        return (0, dn, up) if g == 0 else (g, up, dn)
    return sorted(rows, key=key)


# ============ 7. 写出 ============
def write_xlsx(rows, code2name, out_path):
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = "Sheet1"
    ws.append(HEADER)
    for r in rows:
        ws.append([r["rid"], r["up"], code2name.get(r["up"], r["up"]), r["upl"],
                   r["dn"], code2name.get(r["dn"], r["dn"]), r["dnl"],
                   r["rt"], r["st"], r["bl"], r["src"], r["conf"]])
    f_h = Font(name="微软雅黑", size=10, bold=True)
    f_b = Font(name="微软雅黑", size=10)
    for c in ws[1]: c.font = f_h
    for ri in range(2, ws.max_row+1):
        for c in ws[ri]: c.font = f_b
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    wb.save(out_path)


# ============ 主流程 ============
def main():
    ap = argparse.ArgumentParser(description="生成产品上下游关系 Excel")
    ap.add_argument("product", help="产品编号，如 3923")
    ap.add_argument("--kb",      default=DEFAULT_KB,    help="产品分类知识库路径(默认随skill分发)")
    ap.add_argument("--graph",   default=DEFAULT_GRAPH, help="产业链图谱路径(默认随skill分发)")
    ap.add_argument("--kbmap",   default=None,
                    help="图谱节点名->KB码：可直接传 JSON 字符串(推荐,不落文件)，或传已有 json 路径")
    ap.add_argument("--edges",   default=None,
                    help="大模型产出的边数据：可直接传 JSON 字符串(推荐,不落文件)，或传已有 json 路径")
    ap.add_argument("--gongyi",  default=None, help="可选：复用已有的工艺常识 Excel(12列表)")
    ap.add_argument("--head-ent",default=None, help="头部企业名称(驱动税票商品/上市信息穿透)")
    ap.add_argument("--graph-rt",default="物料投入",
                    help="产业图谱来源的默认关系类型(默认物料投入)；设备类链条可设装备支撑")
    ap.add_argument("--no-chanye",action="store_true",
                    help="关闭脚本内置的图谱采集，改由大模型自行解析《产业链图谱》后经 --edges 给出")
    ap.add_argument("--out",     default=None, help="输出路径(默认写入当前目录)")
    a = ap.parse_args()

    code2name, code2level, parent = load_kb(a.kb)
    # int值 -> 零补齐规范编码(L1=2/L2=4/L3=6/L4=8)，用于把入参/边里的编码统一归位到KB形式
    int2code = {int(k): k for k in code2level}
    product = int2code.get(int(a.product), str(int(a.product)))
    product_name = code2name.get(product, product)
    if not a.out:
        a.out = os.path.join(os.getcwd(), f"{product}{product_name}.xlsx")

    if a.no_chanye:
        chanye = ([], "产业图谱：已用 --no-chanye 关闭脚本内置采集，改由 --edges 提供")
    else:
        chanye = collect_chanye(product, product_name, a.graph, code2name, a.kbmap, a.graph_rt)
    logs, all_edges = [], []
    for es, msg in [
        collect_edges(a.edges),
        collect_gongyi(product, a.gongyi),
        collect_shuipiao(product, a.head_ent),
        collect_shangshi(product, a.head_ent),
        collect_yuqing(product, product_name),
        chanye,
    ]:
        all_edges += es; logs.append(f"  {msg}")

    # 统一将边编码规范为零补齐定宽(与 KB 一致)：已规范的保留，未补齐的按 int 值归位
    def norm(c):
        try:
            iv = int(c)
        except (ValueError, TypeError):
            return str(c)
        return int2code.get(iv, str(iv))
    all_edges = [dict(e, up=norm(e["up"]), dn=norm(e["dn"])) for e in all_edges]

    # 相互替代等横向关系成对落边
    all_edges = expand_bidirectional(all_edges)

    rows = merge(all_edges, code2level)
    before = len(rows)
    rows = remove_inherited(rows, parent)
    rows = sort_rows(rows, product)          # 三段排序：系列作下游 -> 系列作上游 -> 非系列相关

    bad = [r for r in rows if r["up"] not in code2name or r["dn"] not in code2name]
    write_xlsx(rows, code2name, a.out)

    from collections import Counter
    sc, cf = Counter(), Counter()
    for r in rows:
        for s in r["src"].split(SEP): sc[s] += 1
        cf[r["conf"]] += 1

    print(f"产品: {product} {product_name}")
    print("来源采集:")
    for l in logs: print(l)
    print(f"合并后唯一边: {before} | 剔除冗余继承边: {before-len(rows)} | 最终自有边: {len(rows)}")
    gc = Counter(row_group(r, product) for r in rows)
    print(f"排序分组: 系列作下游 {gc[0]} | 系列作上游 {gc[1]} | 非系列相关 {gc[2]}")
    rtc = Counter(r["rt"] for r in rows)
    print("依据来源覆盖:", dict(sc), "| 置信度:", dict(cf), "| 悬空端点:", len(bad))
    print("关系类型分布:", dict(rtc))
    missing = [s for s in TOOL_HINT if sc.get(s, 0) == 0]
    if missing:
        print("取数缺口（脚本不自动调 MCP；需由调用方取数后经 --edges 注入）:")
        for s in missing:
            print(f"  - {s}: {TOOL_HINT[s]}")
    print("已写出:", a.out)


if __name__ == "__main__":
    main()
