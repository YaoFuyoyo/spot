// =====================================================================
// 产品上下游关系网 接口 —— 依据 skills/product-updown-excel 生成 12 列上下游关系 Excel
// 对外路径：/api/updown（本地 server.js 转调；vercel.json 同步登记）
//
// 流程（对齐 SKILL.md《两条取数路径》的路径 B，边数据不落中间文件）：
//   1. Node 侧加载《产品分类知识库》层级表（与生成器读同一份文件，进程内缓存）
//   2. 校验产品编号（零补齐还原），确定产品及其全下级子树
//   3. 多来源并行采集（LLM 只给产品名，Node 负责对齐 KB 编码，禁止大模型编编码）：
//        工艺常识  大模型按领域共识直接给边（src=工艺常识）
//        税票商品  amardata MCP R1401 供应链交易 -> R1521V2 企业产品 -> LLM 对齐
//                  （依赖「头部企业」入参，对应 skill 的 --head-ent）
//        上市信息  amardata MCP R4G04V2 三段文本 -> LLM 解析上下游 -> 对齐
//        舆情资讯  amardata MCP R331 舆情检索 -> LLM 分析文章 -> 对齐
//   4. spawn skill 自带生成器 scripts/generate_updown.py（--edges 注入全部已对齐边；
//      产业图谱由生成器内置精确同名匹配采集），产出《{编号}{名称}.xlsx》返回 base64
//
// 依赖：本机 python3 + openpyxl（可用 UPDOWN_PYTHON 指定解释器）；
//       amardata MCP 端点 AMARDATA_MCP_URL（未配置时三个接口来源为 0 条并回报缺口）。
// =====================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require(path.join(__dirname, '../../common/vendor/xlsx.full.min.js'));

const SKILL_ROOT = path.join(__dirname, '../../skills/product-updown-excel');
const KB_XLSX = path.join(SKILL_ROOT, 'references', '产品分类知识库.xlsx');
const GEN_PY = path.join(SKILL_ROOT, 'scripts', 'generate_updown.py');

const BASE = (process.env.LLM_BASE || 'http://10.2.13.11:3000').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180e3);
const BODY_JSON_LIMIT = 1 * 1024 * 1024; // 请求体上限 1MB
const PY_EXE = process.env.UPDOWN_PYTHON || 'python';
const SCRIPT_TIMEOUT_MS = Number(process.env.UPDOWN_SCRIPT_TIMEOUT_MS || 240e3);
const MAX_SUBTREE_LINES = 400;           // 提示词中子树词表最多列出的行数

// amardata MCP（streamableHttp；4 个工具同端点，见 SKILL.md《API 对接表》）
const AMARDATA_URL = (process.env.AMARDATA_MCP_URL || '').trim();
const AMARDATA_TIMEOUT_MS = Number(process.env.AMARDATA_TIMEOUT_MS || 60e3);
const MAX_TAX_PARTNERS = 20;             // 税票来源最多穿透的交易方数

// ===================== KB 加载（缓存；与生成器同一份数据文件） =====================
let KB = null;
function loadKB() {
  if (KB) return KB;
  const wb = XLSX.read(fs.readFileSync(KB_XLSX));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['层级'], { header: 1 });
  const code2name = new Map();   // 编码 -> 层级表原始名称（含「主名：同义词」复合，与生成器口径一致）
  const code2main = new Map();   // 编码 -> 主名（用于展示与文件名）
  const code2level = new Map();  // 编码 -> 层级 1~4
  const name2code = new Map();   // 主名/同义词 -> 编码（同名保留首个）
  // 编码归一与生成器 load_kb 一致：数值经 int 后按 2×层级 补零
  const norm = (v, lv) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === '') return null;
    if (!/^\d+$/.test(s)) return s;
    return String(parseInt(s, 10)).padStart(2 * lv, '0');
  };
  for (const r of rows.slice(1)) {
    for (let lv = 1; lv <= 4; lv++) {
      const code = norm(r[2 * (lv - 1)], lv);
      if (!code) continue;
      const rawName = r[2 * (lv - 1) + 1] == null ? '' : String(r[2 * (lv - 1) + 1]).trim();
      const ci = rawName.search(/[：:]/);
      const main = (ci >= 0 ? rawName.slice(0, ci) : rawName).trim();
      code2name.set(code, rawName || code);
      code2main.set(code, main || code);
      code2level.set(code, lv);
      if (main && !name2code.has(main)) name2code.set(main, code);
      if (ci >= 0) {
        for (const syn of rawName.slice(ci + 1).split(/[；;]/)) {
          const t = syn.trim();
          if (t && !name2code.has(t)) name2code.set(t, code);
        }
      }
    }
  }
  const int2code = new Map(); // int 值 -> 规范编码（还原用户输入丢失的前导零）
  for (const c of code2level.keys()) {
    const k = parseInt(c, 10);
    if (!int2code.has(k)) int2code.set(k, c);
  }
  KB = { code2name, code2main, code2level, name2code, int2code };
  return KB;
}

function subtreeOf(code) {
  const kb = loadKB();
  const byLevel = { 1: [], 2: [], 3: [], 4: [] };
  for (const c of kb.code2level.keys()) {
    if (c.startsWith(code)) byLevel[kb.code2level.get(c)].push(c);
  }
  // 浅层优先装入词表，超出预算截断并注明
  const picked = [];
  let truncated = 0;
  for (let lv = 1; lv <= 4 && picked.length < MAX_SUBTREE_LINES; lv++) {
    const list = byLevel[lv];
    const room = MAX_SUBTREE_LINES - picked.length;
    if (list.length <= room) picked.push(...list);
    else { picked.push(...list.slice(0, room)); truncated = list.length - room; break; }
  }
  return { codes: picked, total: picked.length + truncated, truncated };
}

// 提示词共用的词表块：产品系列词表 + 全库一二级词表
function vocabBlocks(code, sub) {
  const kb = loadKB();
  const subLines = sub.codes.map(c => `${c} ${kb.code2main.get(c)}`).join('\n');
  const subNote = sub.truncated ? `（下级共 ${sub.total} 个，仅列前 ${sub.codes.length} 个）` : `（共 ${sub.total} 个）`;
  const coarse = [];
  for (const [c, lv] of kb.code2level) {
    if (lv <= 2) coarse.push(`${c} ${kb.code2main.get(c)}`);
  }
  return {
    sub: `【该产品系列的标准产品词表】${subNote}（编码 名称）\n${subLines}`,
    coarse: `【全库一二级标准产品词表】（编码 名称，供跨系列取上游/下游时对齐标准名称）\n${coarse.join('\n')}`
  };
}

// ===================== 通用基础 =====================
function requireKey() {
  const key = (process.env.LLM_API_KEY || '').trim();
  if (!key) throw new Error('未配置 LLM_API_KEY（本地请见 .env，生产环境请在部署平台环境变量中配置）');
  return key;
}

function writeJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > BODY_JSON_LIMIT) { req.destroy(); reject(new Error('请求体过大')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ===================== LLM（统一 JSON 输出；各来源提示词口径对齐 SKILL.md） =====================
const RT_RULES = [
  '- rt（关系类型）从以下五类中选，按判定指引选择，严禁一律写成物料投入：',
  '  物料投入=上游被消耗或转化为下游实体组成部分；装备支撑=上游是生产下游所用的设备/产线/生产设施；服务支撑=上游提供检测/认证/运维/设计/EDA软件等服务；联产副产=同一工艺中联产（up为主产品，dn为副产品）；相互替代=两者可互相替代（横向关系）。',
  '- st（关系强度）从 强/中/弱 中选：领域强共识=强，一般常识=中，弱关联=弱。'
].join('\n');

function buildPrompt(code, name, level, sub) {
  const vocab = vocabBlocks(code, sub);
  return [
    '你是产业链研究专家。请基于领域共识知识（工艺常识），为指定产品及其下级子产品构建上下游关系边，最终只输出一个合法 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
    `本次入参产品：编号 ${code}，名称「${name}」，层级 L${level}。`,
    '',
    vocab.sub,
    '',
    vocab.coarse,
    '',
    '【输出JSON结构】',
    '{ "edges": [ { "up": "上游产品名", "dn": "下游产品名", "rt": "关系类型", "st": "关系强度" } ] }',
    '',
    '【取值规则】',
    '- up/dn 填产品名称（不是编码）：优先一字不差地取自上方两个词表中的标准名称；词表确实没有时可用通用行业产品名，系统会做对齐，对不上的会被丢弃。',
    '- 围绕入参产品本身及其词表中的子产品建边：给出各自的上游供应与下游应用；也可包含与该系列强相关的其他关系。',
    RT_RULES,
    '- 严禁把分类从属（父类目与子类目）当作上下游；严禁 up 与 dn 相同；严禁编造不存在的具体产品。',
    '- 边数量与子树规模匹配：一般 10~40 条。',
    '',
    '请严格只输出这个 JSON。'
  ].join('\n');
}

async function callLLMJson(system, user) {
  const payload = {
    model: MODEL,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + requireKey() },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error('无法连接大模型服务：' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('大模型接口返回 ' + resp.status + '：' + txt.slice(0, 300));
  }
  const j = await resp.json();
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  let content = msg && (msg.content || msg.reasoning_content);
  if (!content) throw new Error('大模型未返回内容');
  content = String(content)
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/```(?:json|JSON)?/g, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(content);
  } catch (e) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    const sliced = start >= 0 && end > start ? content.slice(start, end + 1) : content;
    try { return JSON.parse(sliced); }
    catch (e2) { throw new Error('大模型返回无法解析为 JSON，请重试。原始片段：' + content.slice(0, 200)); }
  }
}

// 来源1：工艺常识（大模型按领域共识直接给边）
async function generateEdges(code, name, level, sub) {
  const obj = await callLLMJson(
    buildPrompt(code, name, level, sub),
    `请为产品 ${code} ${name} 及其子产品生成工艺常识上下游关系边。`
  );
  return Array.isArray(obj.edges) ? obj.edges : [];
}

// 头部企业推断（用户未输入时）：大模型按行业共识给出代表企业全称，随后由 MCP 事实来源验证
async function inferHeadEnt(productName) {
  const obj = await callLLMJson(
    [
      '你是产业链研究专家。请给出指定产品领域中最具代表性的头部企业，要求：',
      '- 优先 A 股上市公司；使用工商注册全称（如「宁德时代新能源科技股份有限公司」），不要用简称或品牌名。',
      '- 最终只输出一个合法 JSON 对象，不要输出任何解释。'
    ].join('\n'),
    `产品：「${productName}」\n【输出JSON结构】{ "ent": "企业工商注册全称", "why": "一句话理由" }\n请严格只输出这个 JSON。`
  );
  const ent = String(obj.ent || '').trim();
  if (!ent) throw new Error('大模型未给出头部企业');
  return ent;
}

// ===================== amardata MCP 客户端（streamableHttp，零 npm 依赖） =====================
let mcpReadyPromise = null;
let mcpNextId = 1;

async function mcpRpc(method, params, expectId = true) {
  const id = expectId ? mcpNextId++ : undefined;
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (id !== undefined) body.id = id;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AMARDATA_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(AMARDATA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `MCP 请求超时（${AMARDATA_TIMEOUT_MS / 1000}s）` : '无法连接 MCP：' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!expectId) return null;
  if (!resp.ok) throw new Error('MCP HTTP ' + resp.status);
  const ctype = resp.headers.get('content-type') || '';
  const text = await resp.text();
  let payload = null;
  if (ctype.includes('event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.id === id) { payload = j; break; }
        } catch (e) { /* 忽略非本次响应事件 */ }
      }
    }
    if (!payload) throw new Error('MCP SSE 流中无本次响应');
  } else {
    try { payload = JSON.parse(text); }
    catch (e) { throw new Error('MCP 返回非 JSON：' + text.slice(0, 120)); }
  }
  if (payload.error) throw new Error('MCP 错误：' + JSON.stringify(payload.error).slice(0, 200));
  return payload;
}

function mcpReady() {
  if (!AMARDATA_URL) throw new Error('未配置 AMARDATA_MCP_URL');
  if (!mcpReadyPromise) {
    mcpReadyPromise = (async () => {
      await mcpRpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'spot-updown', version: '1.0.0' }
      });
      await mcpRpc('notifications/initialized', undefined, false).catch(() => {});
    })().catch(e => { mcpReadyPromise = null; throw e; });
  }
  return mcpReadyPromise;
}

async function mcpCallTool(tool, args) {
  // 工具返回的 text 可能是 JSON 字符串字面量（整段 markdown 转义成一行），逐段解包
  const unwrap = s => {
    const t = String(s || '').trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
      try { return String(JSON.parse(t)); } catch (e) { return s; }
    }
    return s;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mcpReady();
      const payload = await mcpRpc('tools/call', { name: tool, arguments: args });
      const r = payload.result;
      if (!r || !Array.isArray(r.content)) throw new Error('MCP 返回无 content');
      if (r.isError) throw new Error(r.content.map(c => c.text || '').join(' ').slice(0, 200) || 'MCP 工具执行错误');
      return r.content.map(c => unwrap(c.text)).join('');
    } catch (e) {
      if (attempt === 1) throw e;
      mcpReadyPromise = null; // 会话可能失效：重新初始化后重试一次
    }
  }
}

// 解析工具返回的 markdown 表格 -> 对象数组（单元格内的竖线不做转义处理，仅用于取结构化列）
function parseMarkdownTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim().startsWith('|'));
  if (lines.length < 3) return [];
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
  const header = cells(lines[0]);
  const rows = [];
  for (const l of lines.slice(2)) {
    const vals = cells(l);
    if (vals.every(v => v === '')) continue;
    const row = {};
    header.forEach((h, i) => { if (h) row[h] = vals[i] || ''; });
    rows.push(row);
  }
  return rows;
}

function roleOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === '1' || s.includes('上游')) return 'up';
  if (s === '2' || s.includes('下游')) return 'dn';
  return null;
}

// ===================== 来源 2~4：amardata MCP 事实来源（每个内部自兜底，失败仅回报缺口） =====================
const ALIGN_RULES = [
  '【对齐规则】',
  '- 「产品」填对齐后的 KB 标准产品名（不是编码）：优先一字不差地取自词表；词表确实没有时可用行业标准产品名，系统会精确匹配，对不上的会被丢弃；无法对齐的条目直接不输出。',
  '- 严禁编造词表中不存在的编码；严禁把分类从属（父类目与子类目）当作上下游关系对齐。'
].join('\n');

// 来源2：税票商品（高置信，R1401 供应链交易 -> R1521V2 企业产品，方向由交易角色决定）
async function collectTax(productName, headEnt, vocab) {
  const src = '税票商品';
  if (!AMARDATA_URL) return { raw: [], detail: '未配置 AMARDATA_MCP_URL' };
  if (!headEnt) return { raw: [], detail: '未指定头部企业且大模型推断失败' };
  const detailBase = `头部企业 ${headEnt}`;
  try {
    const t1401 = await mcpCallTool('enterprise_trade_analysis', { coreEntName: headEnt, tradeCloseness: '一级' });
    const seen = new Set();
    const partners = parseMarkdownTable(t1401)
      .map(r => ({ ent: (r['交易方名称'] || '').trim(), chain: (r['交易方所属产业链'] || '').trim(), role: roleOf(r['交易角色']) }))
      .filter(p => p.ent && p.chain && p.role && !seen.has(p.ent) && seen.add(p.ent))
      .slice(0, MAX_TAX_PARTNERS);
    if (!partners.length) return { raw: [], detail: `${detailBase}；R1401 无有效交易方（需所属产业链非空且交易角色明确）` };

    const withProducts = (await Promise.all(partners.map(async p => {
      try {
        const t = await mcpCallTool('enterprise_industry_chain', { entName: p.ent });
        const products = parseMarkdownTable(t).map(r => (r['企业产品'] || '').trim()).filter(Boolean).join('；');
        return { ...p, products };
      } catch (e) { return { ...p, products: '' }; }
    }))).filter(p => p.products);
    if (!withProducts.length) return { raw: [], detail: `${detailBase}；${partners.length} 家交易方均无企业产品数据` };

    const sys = [
      '你是产业链数据对齐专家。请把素材中各交易方企业的产品对齐到 KB 标准产品名，并给出关系类型与强度，最终只输出一个合法 JSON 对象，不要输出任何解释。',
      '',
      vocab.sub, '', vocab.coarse, '',
      '【输出JSON结构】',
      '{ "items": [ { "企业": "交易方企业名称(原文)", "产品": "对齐后的KB标准产品名", "rt": "关系类型", "st": "关系强度" } ] }',
      '',
      ALIGN_RULES,
      RT_RULES
    ].join('\n');
    const user = '素材（企业产品原文，交易角色：1=该企业是头部企业的上游供应方，2=该企业是头部企业的下游客户）：\n' +
      JSON.stringify(withProducts.map(p => ({ 企业: p.ent, 交易角色: p.role === 'up' ? '1(上游)' : '2(下游)', 产品: p.products })), null, 1);
    const obj = await callLLMJson(sys, user);

    const byEnt = new Map(withProducts.map(p => [p.ent, p]));
    const raw = [];
    for (const it of (Array.isArray(obj.items) ? obj.items : [])) {
      const p = byEnt.get(String(it['企业'] || '').trim());
      const nm = String(it['产品'] || '').trim();
      if (!p || !nm) continue;
      const base = { rt: RT_SET.has(it.rt) ? it.rt : '物料投入', st: ST_SET.has(it.st) ? it.st : '中', src };
      raw.push(p.role === 'up' ? { up: nm, dn: productName, ...base } : { up: productName, dn: nm, ...base });
    }
    return { raw, detail: `${detailBase}；R1401 交易方 ${partners.length} 家（${withProducts.length} 家取到产品），R1521V2 对齐 ${raw.length} 条` };
  } catch (e) {
    return { raw: [], detail: `采集失败：${e.message}` };
  }
}

// 来源3：上市信息（中置信，R4G04V2 三段文本 -> LLM 解析上下游）
async function collectListed(productName, headEnt, vocab) {
  const src = '上市信息';
  if (!AMARDATA_URL) return { raw: [], detail: '未配置 AMARDATA_MCP_URL' };
  if (!headEnt) return { raw: [], detail: '未指定头部企业且大模型推断失败' };
  try {
    const t = await mcpCallTool('enterprise_listed_info', { name: headEnt });
    const rows = parseMarkdownTable(t);
    const pick = col => rows.map(r => (r[col] || '').trim()).filter(Boolean).join('\n').slice(0, 6000);
    let mainProducts = pick('主要产品');
    let mainBusin = pick('主营业务');
    let profile = pick('公司简介');
    // 表格列错位（单元格含竖线等）时回退：把原文截断后直接交 LLM 解析
    const rawFallback = !mainProducts && !mainBusin && !profile;
    if (rawFallback) {
      mainProducts = '';
      mainBusin = '';
      profile = t.slice(0, 8000);
    }
    if (!mainProducts && !mainBusin && !profile) return { raw: [], detail: `头部企业 ${headEnt}；未取到 主要产品/主营业务/公司简介 三段文本` };

    const sys = [
      '你是产业链研究专家。请从给定的上市公司资料（主要产品/主营业务/公司简介三段文本，或含这些字段的原始表格）中解析上游（采购/成本构成）与下游（应用领域），并把产品对齐到 KB 标准产品名，最终只输出一个合法 JSON 对象，不要输出任何解释。',
      '',
      vocab.sub, '', vocab.coarse, '',
      '【输出JSON结构】',
      '{ "items": [ { "side": "up或dn", "产品": "对齐后的KB标准产品名", "rt": "关系类型", "st": "关系强度" } ] }',
      '（side=up 表示该产品是头部企业的上游，side=dn 表示下游）',
      '',
      ALIGN_RULES,
      RT_RULES,
      '- KB 中无对应编码的工序/服务类描述不要输出。'
    ].join('\n');
    const user = `头部企业：${headEnt}\n【主要产品】\n${mainProducts || '（无）'}\n\n【主营业务】\n${mainBusin || '（无）'}\n\n【公司简介】\n${profile || '（无）'}${rawFallback ? '\n\n（以上为接口原始表格，请自行定位 主要产品/主营业务/公司简介 字段取值）' : ''}`;
    const obj = await callLLMJson(sys, user);

    const raw = [];
    for (const it of (Array.isArray(obj.items) ? obj.items : [])) {
      const nm = String(it['产品'] || '').trim();
      if (!nm) continue;
      const base = { rt: RT_SET.has(it.rt) ? it.rt : '物料投入', st: ST_SET.has(it.st) ? it.st : '中', src };
      raw.push(it.side === 'up' ? { up: nm, dn: productName, ...base } : { up: productName, dn: nm, ...base });
    }
    return { raw, detail: `头部企业 ${headEnt}；三段文本解析对齐 ${raw.length} 条` };
  } catch (e) {
    return { raw: [], detail: `采集失败：${e.message}` };
  }
}

// 来源4：舆情资讯（低置信，R331 舆情检索 -> LLM 分析文章得出上下游）
async function collectSentiment(productName, vocab) {
  const src = '舆情资讯';
  if (!AMARDATA_URL) return { raw: [], detail: '未配置 AMARDATA_MCP_URL' };
  try {
    const t = await mcpCallTool('enterprise_sentiment', { keyword: productName });
    // 文章内容含竖线等字符会破坏表格列对齐，不做列抽取：把解包后的原始 markdown 截断后直接交 LLM 分析
    if (!t || !t.trim()) return { raw: [], detail: `keyword=「${productName}」无舆情文章` };
    const rawText = t.slice(0, 8000);

    const sys = [
      '你是产业链研究专家。请分析给定的舆情资讯原始资料（可能为 markdown 表格，包含 文章标题/文章内容 等字段，字段值内可能含竖线等干扰字符，请自行定位字段取值并忽略表格符号），从中得出产品的上下游关系，并把产品对齐到 KB 标准产品名，最终只输出一个合法 JSON 对象，不要输出任何解释。',
      '',
      vocab.sub, '', vocab.coarse, '',
      '【输出JSON结构】',
      '{ "items": [ { "side": "up或dn", "产品": "对齐后的KB标准产品名", "rt": "关系类型", "st": "关系强度" } ] }',
      '（side=up 表示该产品是入参产品的上游，side=dn 表示下游；仅依据文章内容有明确依据时输出）',
      '',
      ALIGN_RULES,
      RT_RULES
    ].join('\n');
    const user = `入参产品：「${productName}」\n舆情资讯原始内容：\n${rawText}`;
    const obj = await callLLMJson(sys, user);

    const raw = [];
    for (const it of (Array.isArray(obj.items) ? obj.items : [])) {
      const nm = String(it['产品'] || '').trim();
      if (!nm) continue;
      const base = { rt: RT_SET.has(it.rt) ? it.rt : '物料投入', st: ST_SET.has(it.st) ? it.st : '中', src };
      raw.push(it.side === 'up' ? { up: nm, dn: productName, ...base } : { up: productName, dn: nm, ...base });
    }
    return { raw, detail: `keyword=「${productName}」，原文 ${rawText.length} 字分析对齐 ${raw.length} 条` };
  } catch (e) {
    return { raw: [], detail: `采集失败：${e.message}` };
  }
}

// ===================== 名称 -> KB 编码对齐（主名/同义词精确匹配；纯数字按编码归一） =====================
function alignName(s, productCtx) {
  const kb = loadKB();
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (productCtx && t === productCtx.name) return productCtx.code;
  if (kb.name2code.has(t)) return kb.name2code.get(t);
  if (/^\d+$/.test(t)) return kb.int2code.get(parseInt(t, 10)) || null;
  return null;
}

const RT_SET = new Set(['物料投入', '装备支撑', '服务支撑', '联产副产', '相互替代']);
const ST_SET = new Set(['强', '中', '弱']);

function alignEdges(raw, productCtx) {
  const edges = [];
  const unmapped = new Set();
  let selfLoop = 0;
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const up = alignName(e.up, productCtx);
    const dn = alignName(e.dn, productCtx);
    if (!up) { const t = String(e.up || '').trim(); if (t) unmapped.add(t); continue; }
    if (!dn) { const t = String(e.dn || '').trim(); if (t) unmapped.add(t); continue; }
    if (up === dn) { selfLoop++; continue; }
    edges.push({
      up, dn,
      rt: RT_SET.has(e.rt) ? e.rt : '物料投入',
      st: ST_SET.has(e.st) ? e.st : '中',
      src: e.src || '工艺常识'
    });
  }
  return { edges, unmapped: [...unmapped], selfLoop };
}

// ===================== 调 skill 生成器（scripts/generate_updown.py） =====================
function runGenerator(code, edges) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `updown_${code}_${Date.now()}.xlsx`);
    const args = [GEN_PY, code, '--edges', JSON.stringify(edges), '--out', outPath];
    const child = spawn(PY_EXE, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true
    });
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (!done) { child.kill(); reject(new Error(`生成器超时（${SCRIPT_TIMEOUT_MS / 1000}s），已终止`)); done = true; }
    }, SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(new Error('无法启动 Python 生成器：' + e.message + '（需本机 python3 + openpyxl，可用 UPDOWN_PYTHON 指定解释器）')); } });
    child.on('close', exitCode => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (exitCode !== 0 || !fs.existsSync(outPath)) {
        reject(new Error('生成器运行失败：' + (stderr || stdout).slice(-600)));
        return;
      }
      try {
        const buf = fs.readFileSync(outPath);
        fs.unlinkSync(outPath);
        resolve({ base64: buf.toString('base64'), stdout });
      } catch (e) {
        reject(new Error('读取生成结果失败：' + e.message));
      }
    });
  });
}

// 解析生成器 stdout，产出可读汇总
function parseStdout(log) {
  const lines = log.split(/\r?\n/);
  const pick = re => { const m = log.match(re); return m ? m[1] : ''; };
  const gapIdx = lines.findIndex(l => l.includes('取数缺口'));
  const gaps = gapIdx >= 0
    ? lines.slice(gapIdx + 1).filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, ''))
    : [];
  const graphLine = lines.map(l => l.trim()).find(l => l.startsWith('产业图谱：')) || '产业图谱：（生成器无输出）';
  return {
    gaps,
    graphLine,
    unique: pick(/合并后唯一边:\s*(\d+)/),
    removed: pick(/剔除冗余继承边:\s*(\d+)/),
    final: pick(/最终自有边:\s*(\d+)/),
    groupDn: pick(/系列作下游\s*(\d+)/),
    groupUp: pick(/系列作上游\s*(\d+)/),
    groupOther: pick(/非系列相关\s*(\d+)/),
    typeDist: pick(/关系类型分布:\s*(.+)/),
    dangling: pick(/悬空端点:\s*(\d+)/)
  };
}

// ===================== 接口处理器（部署平台入口；亦兼容本地 server.js 转调） =====================
module.exports = async function handler(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return writeJSON(res, 400, { ok: false, error: '请求体须为合法 JSON' }); }

  const rawInput = String(body.product || '').trim();
  if (!/^\d+$/.test(rawInput)) return writeJSON(res, 400, { ok: false, error: '产品编号须为数字，如 3923' });
  let headEnt = String(body.head_ent || '').trim();

  try {
    const kb = loadKB();
    const code = kb.int2code.get(parseInt(rawInput, 10));
    if (!code) return writeJSON(res, 400, { ok: false, error: `产品编号 ${rawInput} 在《产品分类知识库》中不存在，请核对后重试` });
    const name = kb.code2main.get(code);
    const level = kb.code2level.get(code);
    const sub = subtreeOf(code);
    const vocab = vocabBlocks(code, sub);
    const productCtx = { code, name };

    // 头部企业：输入则取输入值；未输入则由大模型推断（推断失败不整体失败，税票/上市两来源回报缺口）
    let headEntSrc = '用户输入';
    if (!headEnt) {
      try { headEnt = await inferHeadEnt(name); headEntSrc = '大模型推断'; }
      catch (e) { headEntSrc = '推断失败'; }
    }

    // 各来源并行采集（工艺常识失败则整体失败；MCP 来源失败仅回报缺口）
    const [gongyiRaw, tax, listed, sentiment] = await Promise.all([
      generateEdges(code, name, level, sub).then(es => es.map(e => ({ ...e, src: '工艺常识' }))),
      collectTax(name, headEnt, vocab),
      collectListed(name, headEnt, vocab),
      collectSentiment(name, vocab)
    ]);
    const allRaw = [...gongyiRaw, ...tax.raw, ...listed.raw, ...sentiment.raw];
    const aligned = alignEdges(allRaw, productCtx);

    // 3) 调 skill 生成器（--edges 注入；产业图谱由生成器内置采集）
    const { base64, stdout } = await runGenerator(code, aligned.edges);
    const stats = parseStdout(stdout);

    // 来源采集汇总（对齐后口径；0 条给出原因）
    const srcLine = (src, rawN, detail) =>
      alignedBySrc(aligned.edges, src) > 0
        ? `${src}：${alignedBySrc(aligned.edges, src)} 条（原始 ${rawN} 条；${detail}）`
        : `${src}：0 条（${detail}）`;
    const sources = [
      srcLine('工艺常识', gongyiRaw.length, '大模型生成'),
      srcLine('税票商品', tax.raw.length, tax.detail),
      srcLine('上市信息', listed.raw.length, listed.detail),
      srcLine('舆情资讯', sentiment.raw.length, sentiment.detail),
      stats.graphLine + '（生成器内置精确同名匹配）'
    ];

    return writeJSON(res, 200, {
      ok: true,
      summary: {
        file: `${code}${name}.xlsx`,
        product_code: code,
        product_name: name,
        product_level: 'L' + level,
        subtree_count: sub.total,
        subtree_truncated: sub.truncated > 0 ? sub.truncated : 0,
        head_ent: headEnt,
        head_ent_src: headEntSrc,
        llm_edges: gongyiRaw.length,
        aligned_edges: aligned.edges.length,
        self_loop_dropped: aligned.selfLoop,
        unmapped: aligned.unmapped.slice(0, 30),
        unique_edges: stats.unique,
        removed_inherited: stats.removed,
        final_edges: stats.final,
        groups: `系列作下游 ${stats.groupDn} / 系列作上游 ${stats.groupUp} / 非系列相关 ${stats.groupOther}`,
        type_dist: stats.typeDist,
        dangling: stats.dangling,
        sources,
        gaps: stats.gaps,
        log: stdout.slice(-2000)
      },
      file: { name: `${code}${name}.xlsx`, base64 }
    });
  } catch (err) {
    return writeJSON(res, 500, { ok: false, error: err.message || '服务器内部错误' });
  }
};

function alignedBySrc(edges, src) {
  let n = 0;
  for (const e of edges) if (e.src === src) n++;
  return n;
}
