// =====================================================================
// 新增产业链 接口 —— 产业链配置表生成服务（Node）
// 对外路径：/api/addchain（由部署配置路由）
// 本地开发：server.js 直接转调本文件的默认导出，避免逻辑重复维护
//
// 严格遵循 skills/industry-chain-graph/SKILL.md 的流程与格式：
//   参考文件         -> 用于约束 产业分类/产业领域/国标/申万 码值
//   模板-空表.xlsx   -> 作为输出工作簿（概况/图谱 + 预留 上链/挂链 空 sheet）
//   编号/图谱/概况   -> 完全照按 SKILL Step2~5 的硬性规则生成
//
// 密钥与配置一律从环境变量读取：LLM_API_KEY / LLM_BASE / LLM_MODEL。
//   - 生产环境：在部署平台的环境变量中配置。
//   - 本地开发：写入根目录 .env（server.js 启动时加载，已被 .gitignore 忽略）。
// 未配置时接口返回明确错误，绝不回退到硬编码密钥。
// =====================================================================

const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '../../common/vendor/xlsx.full.min.js'));

const BASE = (process.env.LLM_BASE || 'http://10.2.13.11:3000').replace(/\/+$/, '');
// 网关实际可用模型为 gpt-5.6-luna
const MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180e3);
const BODY_JSON_LIMIT = 1 * 1024 * 1024; // 请求体上限 1MB

// ===================== 参考文件读取（缓存，来自 skill references/） =====================
const REF_DIR = path.join(__dirname, '../../skills/industry-chain-graph/references');

function readSheetRows(file, sheetName) {
  const wb = XLSX.read(fs.readFileSync(file));
  const ws = wb.Sheets[sheetName];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1 }) : [];
}

let REF = null;
function loadRefs() {
  if (REF) return REF;
  const ref = { classMap: [], lvList: [], gb: [], sw: [] };
  const cls = path.join(REF_DIR, '产业分类与领域.xlsx');

  // 产业分类 sheet(A:分类 B:描述 C:领域 D:产业链)
  readSheetRows(cls, '产业分类').slice(1).forEach(r => {
    const no = String(r[0] || '').trim();
    const domains = String(r[2] || '').trim();
    if (no) ref.classMap.push({ no, domains });
  });
  // 产业领域 sheet(A:领域 B:描述 C:产业链)
  readSheetRows(cls, '产业领域').slice(1).forEach(r => {
    const lv = String(r[0] || '').trim();
    const chains = String(r[2] || '').trim();
    if (lv) ref.lvList.push({ lv, chains });
  });
  // 国标 Sheet1(A:码值 B:名称 C:层级)
  const seenGb = new Set();
  readSheetRows(path.join(REF_DIR, '国标行业.xlsx'), 'Sheet1').slice(1).forEach(r => {
    const code = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    if (code && name && !seenGb.has(code)) { seenGb.add(code); ref.gb.push(code + ' ' + name); }
  });
  // 申万 Sheet2(A:一级 B:名称 C:二级 D:名称 E:三级 F:名称)
  const seenSw = new Set();
  readSheetRows(path.join(REF_DIR, '申万行业.xlsx'), 'Sheet2').slice(1).forEach(r => {
    const code = String(r[4] || '').trim();
    const name = String(r[5] || '').trim();
    if (code && name && !seenSw.has(code)) { seenSw.add(code); ref.sw.push(code + ' ' + name); }
  });

  REF = ref;
  return ref;
}

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

function cnLevel(lv) {
  const map = ['一', '二', '三', '四', '五', '六', '七', '八'];
  return (map[lv - 1] || lv) + '级';
}

/** 构造提示词 —— 忠实于 SKILL Step2~5 的规则与参考码值 */
function buildPrompt(region, industry) {
  const ref = loadRefs();
  const area = region ? `地区“${region}”` : '全国范围（无地区，按全国调研）';

  const classStr = ref.classMap.map(c => `产业分类:${c.no} -> 可选产业领域:${c.domains}`).join('\n');
  const lvStr = ref.lvList.map(l => `产业领域:${l.lv} -> 该领域产业链:${l.chains}`).join('\n');
  const gbStr = ref.gb.join('\n');
  const swStr = ref.sw.join('\n');

  return [
    '你是资深产业链规划专家。请严格按《产业链图谱与概况生成标准》为一条产业链生成配置数据，最终只输出一个合法 JSON 对象，不要输出任何解释、markdown 代码块或多余文字。',
    `本次调研对象：${area}，产业链名称：${industry}。`,
    '',
    '【输出JSON结构】(chain_code 由名称各汉字拼音首字母小写得出，如 生猪->sz；名称含英文取英文首字母)',
    `{
  "chain_code": "${industry} 的拼音首字母编号",
  "chain_name": "${industry}",
  "chain_label": "全国重点发展该产业的省/市，多个用中文分号拼接，如 武汉；河南；湖南；山东",
  "chain_type": 1,
  "chain_info": "250~400字一段式：总体定位→上游→中游→下游→一体化/升级趋势；覆盖图谱主干，融入政策方向；严禁出现任何地区字样",
  "chain_class_one": "产业分类，必须在下方【参考产业分类】中二选一待定：见规则",
  "chain_class_two": "产业领域，必须在下方【参考产业领域】中选取其一",
  "chain_ind_gb": "最相关国标码值（从【参考国标码值】中选，多个用|拼接；仅取中游或核心环节直接对应的码值，准入从严）",
  "chain_ind_sw": "最相关申万三级代码（从【参考申万码值】中选，多个用|拼接；仅取中游或核心环节直接对应的代码，准入从严）",
  "chain_ent_scale": 全国企业量级（数值，单位万，仅企业不含个体工商户，可合理估计）,
  "tree": [
    { "name": "一级节点名(具体赛道)", "core": true/false, "children": [
        { "name": "二级节点", "core": true/false, "children": [
            { "name": "三级节点", "core": true/false, "children": [ {"name":"四级节点","core":false,"children":[]} ] }
        ] }
    ] },
    { "name": "一级节点名", ... },
    { "name": "一级节点名", ... }
  ]
}`,
    '',
    '【参考产业分类】',
    classStr,
    '',
    '【参考产业领域】(字段值必须与下面某项一字不差；依据产业链就近匹配)',
    lvStr,
    '',
    '【参考国标码值】(chain_ind_gb 必须从以下真实码值中选择，禁止编造)',
    gbStr,
    '',
    '【参考申万码值】(chain_ind_sw 必须从以下真实三级代码中选择，禁止编造)',
    swStr,
    '',
    '【图谱规则】',
    '- tree 顶级必须是 3 个一级节点，分别对应上游、中游、下游分支，但节点名称必须是具体赛道名（如“种源与投入品”），严禁出现“上游/中游/下游”字样；此 3 个顶级节点的父节点即产业链根(' + industry + ')。',
    '- 支持 4~8 级，按产业规模定（一般 4~5 级，细分赛道多的可到 6~8 级）；同级分支 3~6 个。',
    '- 设备、辅料等支撑环节归入其所服务环节所在分支。',
    '- 不同节点/产品禁止用 / 、 拼在同一行，必须各占一行；仅“同一含义不同叫法”可在一个节点名内用 /。',
    '- 节点名称用行业通用赛道/产品名，简洁准确(≤12字)，叶子层为具体产品、设备或服务形态。',
    '- 中游=核心产品的生产/制造；下游=加工、流通、销售、服务。',
    '- core=true 表示该产业核心、重点、新兴的节点（附加值高、政策重点、对地区带动强，如示例中养殖/屠宰/繁育）。',
    '- 核心性沿子树传导：父节点 core=true 时，其子节点原则上均应 core=true；严禁出现“父为核心、子却全为非核心”的断层（分支整体非重点时，应从父级起整体 core=false）。',
    '',
    '【概况规则】',
    '- chain_info 一定写成 250~400 字一段式。',
    '- chain_info 中严禁体现地区信息：不得出现任何地区字样（如“咸阳”“陕西”等）；配置的地区仅作为调研重点与图谱生成偏向（赛道取舍、core 判断、chain_label），描述一律按全国视角表述。',
    '- chain_type 恒为 1。',
    '- chain_class_one 从【参考产业分类】中选一项；chain_class_two 从【参考产业领域】中选一项（与其产业链清单就近匹配）。',
    '- chain_ind_gb 必须取自【参考国标码值】真实行；chain_ind_sw 必须取自【参考申万码值】真实行；均禁止编造。',
    '- chain_ind_gb / chain_ind_sw 准入从严：只选与当前产业链中游或核心环节直接对应的行业，严禁把仅上游配套、仅下游流通或泛相关的行业都纳入。',
    '- chain_ent_scale 为整数，不写单位。',
    '',
    '请严格只输出这个 JSON。'
  ].join('\n');
}

async function generateChain(region, industry) {
  const userPrompt = [
    `请生成"${region ? region + ' ' : ''}${industry}产业链"的产业链配置数据。`,
    '地区：' + (region || '（全国）'),
    '产业链名称：' + industry
  ].join('\n');

  const payload = {
    model: MODEL,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildPrompt(region, industry) },
      { role: 'user', content: userPrompt }
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
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) throw new Error('大模型未返回内容');

  let obj;
  try {
    obj = JSON.parse(content);
  } catch (e) {
    const m = content.replace(/```json|```/g, '').replace(/^\s*\{/, '{');
    try { obj = JSON.parse(m); }
    catch (e2) { throw new Error('大模型返回无法解析为 JSON，请重试。原始片段：' + content.slice(0, 200)); }
  }
  obj.industry = industry;
  obj.region = region || '';
  return obj;
}

// ===================== 按 SKILL Step3~5 构建 Excel（基于 模板-空表.xlsx） =====================
function pad2(n) { return String(n).padStart(2, '0'); }

function maxLevelOf(nodes) {
  let m = 0;
  (function walk(list, d) {
    list.forEach(n => { m = Math.max(m, d); if (n.children && n.children.length) walk(n.children, d + 1); });
  })(nodes, 1);
  return m;
}

/** 先序遍历编号并展平成数据行（SKILL Step3/Step4） */
function buildTreeRows(chain, tree) {
  const rows = [];
  tree.forEach((node, i) => {
    const code = chain.chain_code + pad2(i + 1);
    (function walk(n, nodeCode, upCode, upName, level) {
      rows.push({ code: nodeCode, name: n.name, upCode, upName, level, link: i + 1, core: n.core !== false });
      (n.children || []).forEach((c, ci) => walk(c, nodeCode + pad2(ci + 1), nodeCode, n.name, level + 1));
    })(node, code, chain.chain_code, chain.chain_name, 1);
  });
  return rows;
}

function buildWorkbook(chain) {
  const tree = Array.isArray(chain.tree) ? chain.tree : [];
  const maxLevel = Math.max(1, maxLevelOf(tree));
  const fixed = 7;
  const totalCols = maxLevel * 2 + fixed;

  // 以 skill 原模板为基座（保留 概况/图谱/上链策略/挂链策略 及原有设置）
  const wb = XLSX.read(fs.readFileSync(path.join(REF_DIR, '模板-空表.xlsx')));

  // ---- 概况 A1:J3 ----
  const gk = [
    ['产业链编号', '产业链名称', '产业链标签', '结构类型', '产业链描述', '产业分类', '产业领域', '国标行业', '申万行业', '全国企业量级'],
    ['chain_code', 'chain_name', 'chain_label', 'chain_type', 'chain_info', 'chain_class_one', 'chain_class_two', 'chain_ind_gb', 'chain_ind_sw', 'chain_ent_scale'],
    [chain.chain_code, chain.chain_name, chain.chain_label, chain.chain_type || 1, chain.chain_info, chain.chain_class_one, chain.chain_class_two, chain.chain_ind_gb, chain.chain_ind_sw, chain.chain_ent_scale]
  ];
  XLSX.utils.sheet_add_aoa(wb.Sheets['概况'], gk, { origin: 'A1' });

  // ---- 图谱：动态表头（最大层级×2 + 7）----
  const zh = [], en = [];
  for (let L = 1; L <= maxLevel; L++) { zh.push(cnLevel(L) + '节点编号', cnLevel(L) + '节点名称'); en.push('node_code' + L, 'node_name' + L); }
  zh.push('节点编号', '节点名称', '上级节点编号', '上级节点名称', '节点层级', '节点所属环节', '是否核心节点');
  en.push('node_code', 'node_name', 'up_node_code', 'up_node_name', 'node_level', 'node_link', 'is_core_link');

  const rows = buildTreeRows(chain, tree);
  const grid = [zh, en];
  rows.forEach(r => {
    const row = new Array(totalCols).fill(null);
    row[(r.level - 1) * 2] = r.code;
    row[(r.level - 1) * 2 + 1] = r.name;
    const f = maxLevel * 2;
    row[f] = r.code; row[f + 1] = r.name; row[f + 2] = r.upCode; row[f + 3] = r.upName;
    row[f + 4] = r.level; row[f + 5] = r.link; row[f + 6] = r.core ? 'Y' : 'N';
    grid.push(row);
  });

  const tp = wb.Sheets['图谱'];
  XLSX.utils.sheet_add_aoa(tp, grid, { origin: 'A1' });

  // 表头加粗
  const heads = [
    { ws: wb.Sheets['概况'], cols: 10, rows: 2 },
    { ws: tp, cols: totalCols, rows: 2 }
  ];
  heads.forEach(({ ws, cols, rows }) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) ws[addr].s = { font: { bold: true, sz: 10 } };
      }
    }
  });

  // 图谱列宽
  tp['!cols'] = Array.from({ length: totalCols }, (_, i) => ({ wch: i % 2 === 1 ? 12 : 10 }));

  return { wb, maxLevel, rows };
}

// 接口处理器（部署平台入口；亦兼容本地 server.js 转调）
module.exports = async function handler(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return writeJSON(res, 400, { ok: false, error: '请求体须为合法 JSON' }); }

  const region = (body.region || '').trim();
  const industry = (body.industry || '').trim();
  if (!industry) return writeJSON(res, 400, { ok: false, error: '产业链名称不能为空' });

  try {
    const chain = await generateChain(region, industry);
    const { wb, maxLevel, rows } = buildWorkbook(chain);
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    // 兼容 Node Buffer 与字节数组（vendored xlsx full 版 type:'buffer' 返回字节数组）
    const base64 = Buffer.from(buf).toString('base64');
    const fileName = (chain.chain_name || industry) + '产业链.xlsx';

    return writeJSON(res, 200, {
      ok: true,
      summary: {
        file: fileName,
        sheets: ['概况', '图谱', '上链策略', '挂链策略'],
        nodeCount: rows.length,
        level: maxLevel,
        chain_code: chain.chain_code,
        chain_name: chain.chain_name || industry,
        chain_info: chain.chain_info || ''
      },
      file: { name: fileName, base64 }
    });
  } catch (err) {
    return writeJSON(res, 500, { ok: false, error: err.message || '服务器内部错误' });
  }
};