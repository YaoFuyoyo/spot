// =====================================================================
// 产品补充 接口 —— 产品词分析（POST /api/addprod）
// 流程严格对应 skills/product-taxonomy-supplement/SKILL.md：
//   步骤2 存在性校验（精确/同义词/统一替换词）→ 命中即"老词"，直接返回该行，无需大模型；
//   步骤3~6 上下位判断/定级/编码/噪声复检 -> 交给大模型（附知识库候选上下文），
//   本地仅做确定性计算（编号分配、层级/父级校验、行业大类沿用）。
// 输出【结构化】sheet 字段：产品编号+产品名称+产品层级+产品行业大类+产品同义词
// =====================================================================

const path = require('path');
const KB = require(path.join(__dirname, 'kb_data.js'));

// LLM 配置与 tool-addchain 保持一致（环境变量优先）
const BASE = (process.env.LLM_BASE || 'http://10.2.13.11:3000').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180e3);
const BODY_JSON_LIMIT = 1 * 1024 * 1024;

function requireKey() {
  const key = (process.env.LLM_API_KEY || '').trim();
  if (!key) throw new Error('未配置 LLM_API_KEY（本地请见 .env，生产环境请在部署平台环境变量中配置）');
  return key;
}

function writeJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
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

// ===================== 步骤 2：存在性命中直接返回（老词，不调大模型） =====================
function fmtRow(acc, r, synOverride) {
  return [acc.rowCode(r), acc.rowName(r), acc.rowLevel(r), acc.rowIndustry(r),
    synOverride !== undefined ? synOverride : acc.rowSyn(r)];
}

function shortlist(rows, acc, cap) {
  return rows.slice(0, cap || 10).map(r =>
    `${acc.rowCode(r)} | ${acc.rowName(r)} | ${acc.rowLevel(r)}级 | ${acc.rowIndustry(r)} | 同义词: ${acc.rowSyn(r) || '-'}`);
}

// ===================== 步骤 3~6：候选上下文（供大模型判断） =====================
/** 生成词的全部 ≥2 字子串（辅助定位相关分支，如 盾构机 -> 盾构/构机/掘进 等） */
function stems(word) {
  const out = new Set();
  for (let i = 0; i < word.length; i++) {
    for (let j = i + 2; j <= word.length; j++) {
      const s = word.slice(i, j);
      if (s !== word) out.add(s);
    }
  }
  return [...out];
}

function buildContext(word) {
  const acc = KB.rowAccessors;
  const snap = KB.snapshot();
  const pc = KB.precheck(word);
  const generic = new Set([].concat(...Object.values(KB.REPLACE_GROUPS)));

  // 关键词（含替换词）直接命中 + 子串定位的相关分支
  const kwHits = KB.findByKeyword(word, 30);
  const stemHits = [];
  const seen = new Set(kwHits.map(acc.rowCode));
  for (const s of stems(word)) {
    if (generic.has(s)) continue;
    const rows = KB.findByKeyword(s, 8);
    for (const r of rows) {
      if (!seen.has(acc.rowCode(r))) { seen.add(acc.rowCode(r)); stemHits.push(r); }
      if (stemHits.length >= 40) break;
    }
    if (stemHits.length >= 40) break;
  }

  // 候选归属节点（同义词命中 > 替换词命中 > 子串噪声 > 相关分支），每个附 归属链/子级/下一编码
  const focus = [];
  const focusSeen = new Set();
  for (const r of [...pc.asSynonym, ...pc.replaceHits, ...pc.containedIn.slice(0, 8), ...kwHits.slice(0, 8), ...stemHits.slice(0, 12)]) {
    const code = acc.rowCode(r);
    if (focusSeen.has(code)) continue;
    focusSeen.add(code);
    const chain = KB.pathChain(code).map(x => `${acc.rowCode(x)} ${acc.rowName(x)}`);
    const kids = KB.children(code).slice(0, 12).map(x => `${acc.rowCode(x)} ${acc.rowName(x)}`);
    const nx = KB.nextCode(code);
    focus.push({
      row: `${acc.rowCode(r)} | ${acc.rowName(r)} | ${acc.rowLevel(r)}级 | ${acc.rowIndustry(r)}`,
      chain, children: kids,
      nextCode: nx.code || ('已满: ' + nx.error)
    });
    if (focus.length >= 16) break;
  }

  return { snap, pc, kwCount: kwHits.length, stemCount: stemHits.length, focus };
}

// ===================== 提示词（忠实 SKILL 步骤 3~7 与 维护规则.md） =====================
function buildSystemPrompt(word, ctx) {
  const acc = KB.rowAccessors;
  const rgText = Object.entries(KB.REPLACE_GROUPS).map(([k, v]) => `${k}: ${v.join('、')}`).join('\n');
  const l1 = KB.l1List().map(r => `${acc.rowCode(r)} ${acc.rowName(r)}`).join('；');
  // 全量二级节点清单（898 个）：候选归属为空时，供大模型语义选定根父级
  const l2List = KB.l2List().map(r => `${acc.rowCode(r)} ${acc.rowName(r)}`);

  return [
    '你是产品分类知识库维护专家。用户给出一个产品词，你要判定它如何补进知识库，并输出可直接落【结构化】sheet 的数据行。只输出一个合法 JSON 对象，不要任何解释或 markdown 代码块。',
    `本次产品词：「${word}」`,
    '',
    '【知识库规格】',
    '- 4 级分类，每级 2 位数字，总编码 8 位；1 级编码 = 国民经济行业大类 2 位码（C35 ↔ 35）。',
    '- 【结构化】sheet 字段：产品编号 / 产品名称 / 产品层级 / 产品行业大类 / 产品同义词。',
    '- 产品同义词列只放同义词、不含主名、不含冒号，多个用中文分号「；」分隔。',
    '',
    '【判定流程】',
    '1) 存在性：精确同名 / 已是某节点同义词 / 统一替换词等价（系统已预检，结果见下）——任一命中即老词，系统会直接短路返回，无需你判断。',
    '2) 上下位判断（最关键）：对候选归属节点问"该词能否唯一地挂到某个 3 级节点之下"：',
    '   - 不能（是该节点下多个子类的统称/上位词）-> 只能作为该节点同义词（action=synonym），禁止新增；',
    '   - 能（具体细分）-> 作为 4 级产品新增到该 3 级之下（action=add）；',
    '   - 上级节点在库中缺失 -> 从缺失的那一级起逐级新增（action=add，多行）。',
    '3) 输出条数规则（硬性）：新增 4 级=1 条；新增 3 级=该 3 级+其下一个 4 级（≥2 条）；新增 2 级=该 2 级+下级 3 级+再下 4 级（≥3 条）；新增 1 级=逐级向下各补一个直至 4 级（≥4 条）。',
    '   补齐的下级产品必须是真实存在的产品词（优先复用知识库同类分支已有名称），不得凭空编造；无可靠依据时用 action=uncertain 说明。',
    '   parent_code 必须取自【候选归属节点】及其归属链中列出的真实编号，禁止编造任何编号。',
    '',
    '【维护规则】',
    '- 唯一性：名称与同义词全库不得重复；同名不同类须加正则区分词「产品名（区分词1-区分词2）」。',
    '- 层级正确性：先定行业大类再逐级向下，不得跨层级归类；行业大类沿用 1 级祖先。',
    '- 完整性：平铺至 4 级，不新增层级。',
    '- 统一替换词（等价写法无需录入同义词）：\n' + rgText,
    '- 编码由系统按"父级编码+同级顺序号"自动分配，你只给 parent_code，不要自己编号码。',
    '- 子串包含（如 农业机械 ⊂ 农业机械服务）是库内常态，不阻断，但请在 notes 中列出供人工复核。',
    '',
    '【知识库快照】结构化 ' + ctx.snap.structRows + ' 行；层级 ' + ctx.snap.levelRows + ' 行；一级节点 ' + l1,
    '',
    '【存在性预检结果】',
    '- 精确同名：' + (shortlist(ctx.pc.exact, acc).join(' ; ') || '无'),
    '- 已作同义词：' + (shortlist(ctx.pc.asSynonym, acc).join(' ; ') || '无'),
    '- 替换词等价写法：' + (ctx.pc.variants.join('、') || '无'),
    '- 替换词命中：' + (shortlist(ctx.pc.replaceHits, acc).join(' ; ') || '无'),
    '- 被更长产品名包含（噪声候选）：' + (shortlist(ctx.pc.containedIn, acc, 15).join(' ; ') || '无'),
    '',
    '【候选归属节点】（row | 归属链 | 直接子级 | 下一可用编码）',
    ctx.focus.map(f => `- ${f.row}\n  链: ${f.chain.join(' > ') || '-'}\n  子级: ${f.children.join('、') || '-'}\n  下一编码: ${f.nextCode}`).join('\n') || '无（词本身无子串命中，请从下方二级节点清单中语义选定根父级）',
    '',
    '【二级节点清单】（编号 名称；归属分支缺失时从这里选根父级，禁止使用清单以外的编号）',
    l2List.join('；'),
    '',
    '【输出JSON格式】',
    `{
  "action": "synonym | add | uncertain",
  "target_code": "仅 synonym 时：被挂接节点编号",
  "rows": [
    { "parent_code": "仅 add 时：已存在的父级编号；若父级是本列表上一行新节点则填 NEW", "name": "产品名", "level": 3, "syn": "同义词，可空" }
  ],
  "conclusion": "1~3 句判定依据",
  "notes": ["冲突/噪声/提示，无则空数组"]
}`,
    'synonym 时 rows 留空数组（系统会返回被挂接节点整行，同义词字段已含新词）。'
  ].join('\n');
}

async function callLLM(word, ctx, feedback) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(word, ctx) },
    { role: 'user', content: `产品补充：${word}` }
  ];
  if (feedback) {
    messages.push({ role: 'assistant', content: '（上一次输出）' });
    messages.push({ role: 'user', content: `上一次输出未通过系统校验：${feedback}\n请修正后重新输出完整 JSON（parent_code 必须来自【候选归属节点】及其归属链中的真实编号）。` });
  }
  const payload = {
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages
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
  try { return JSON.parse(content); } catch (e) {
    try { return JSON.parse(content.replace(/```json|```/g, '')); }
    catch (e2) { throw new Error('大模型返回无法解析为 JSON，请重试'); }
  }
}

// ===================== 本地确定性校验 + 编号分配 + spec 组装 =====================
function assembleSynonym(word, targetCode) {
  const acc = KB.rowAccessors;
  const chain = KB.pathChain(targetCode);
  const target = chain[chain.length - 1];
  if (!target) return { error: `编号 ${targetCode} 在知识库中不存在` };
  const syns = KB.synList(acc.rowSyn(target));
  if (acc.rowName(target) === word) {
    return { error: `该词已是 ${targetCode} 的产品名称，无需补充` };
  }
  if (syns.includes(word)) return { error: `该词已是 ${targetCode} 的同义词，无需补充` };
  syns.push(word);
  const newSyn = syns.join('；');
  return {
    action: 'synonym',
    conclusion: `「${word}」作为 ${acc.rowCode(target)} ${acc.rowName(target)}（${acc.rowLevel(target)}级）的同义词挂入。`,
    rows: [fmtRow(acc, target, newSyn)],
    spec: { synonyms: [{ code: acc.rowCode(target), syn: word }], add: [] }
  };
}

function assembleAdd(word, llmRows) {
  const acc = KB.rowAccessors;
  if (!Array.isArray(llmRows) || !llmRows.length) return { error: '大模型未给出新增数据行' };
  const used = [];
  const assigned = new Map(); // 本批次已分配: code -> {level, industry}
  const specRows = [];
  const display = [];
  let prevCode = null;

  for (const r of llmRows) {
    const name = String(r.name || '').trim();
    if (!name) return { error: '新增行缺少产品名称' };
    const parentRef = String(r.parent_code || '').trim().toUpperCase();
    let parentCode, parentLevel, industry;
    if (parentRef === 'NEW') {
      if (!prevCode) return { error: '首行不能引用 NEW（其父级必须是知识库已有节点）' };
      parentCode = prevCode;
      parentLevel = assigned.get(parentCode).level;
      industry = assigned.get(parentCode).industry;
    } else if (assigned.has(parentRef)) {
      // 引用本批次已分配的编号（如首行新 3 级）
      parentCode = parentRef;
      parentLevel = assigned.get(parentRef).level;
      industry = assigned.get(parentRef).industry;
    } else {
      const chain = KB.pathChain(parentRef);
      const top = chain.length ? acc.rowCode(chain[chain.length - 1]) : null;
      if (top !== parentRef) return { error: `父级 ${parentRef} 在知识库中不存在（禁止编造编号）` };
      parentCode = parentRef;
      parentLevel = acc.rowLevel(chain[chain.length - 1]);
      industry = acc.rowIndustry(chain[0]); // 行业大类 = 1 级祖先的行业大类
    }
    const wantLevel = parentLevel + 1;
    if (Number(r.level) !== wantLevel) {
      return { error: `「${name}」层级应为 ${wantLevel} 级（父级为 ${parentLevel} 级），收到 ${r.level}` };
    }
    const nx = KB.nextCode(parentCode, used);
    if (nx.error) return { error: nx.error };
    if (nx.level !== wantLevel) return { error: `「${name}」编码层级 ${nx.level} 与预期 ${wantLevel} 不符` };
    used.push(nx.code);
    assigned.set(nx.code, { level: nx.level, industry });
    const syn = String(r.syn || '').trim();
    specRows.push({ code: nx.code, name, level: nx.level, industry, syn });
    display.push([nx.code, name, nx.level, industry, syn]);
    prevCode = nx.code;
  }
  return {
    action: 'add',
    conclusion: `「${word}」作为新${llmRows.length > 1 ? '增链路（共 ' + llmRows.length + ' 行）' : '产品'}新增。`,
    rows: display,
    spec: { synonyms: [], add: specRows }
  };
}

// ===================== 接口处理器 =====================
module.exports = async function handler(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return writeJSON(res, 400, { ok: false, error: '请求体须为合法 JSON' }); }

  const word = String(body.word || '').trim();
  if (!word) return writeJSON(res, 400, { ok: false, error: '产品词不能为空' });

  try {
    const acc = KB.rowAccessors;
    const pc = KB.precheck(word);
    const noise = pc.containedIn.slice(0, 10).map(r => `${acc.rowCode(r)} ${acc.rowName(r)}`);

    // 步骤 2：存在性命中 -> 老词，直接返回（不调大模型、无落表 spec）
    if (pc.exact.length) {
      const r = pc.exact[0];
      return writeJSON(res, 200, {
        ok: true, action: 'exists',
        conclusion: `「${word}」已存在于知识库：${acc.rowCode(r)} ${acc.rowName(r)}（${acc.rowLevel(r)}级），无需补充。`,
        rows: [fmtRow(acc, r)], notes: noise.length ? ['子串噪声复核：' + noise.join('、')] : [], spec: null
      });
    }
    if (pc.asSynonym.length) {
      const r = pc.asSynonym[0];
      return writeJSON(res, 200, {
        ok: true, action: 'exists',
        conclusion: `「${word}」已是 ${acc.rowCode(r)} ${acc.rowName(r)} 的同义词，无需补充。`,
        rows: [fmtRow(acc, r)], notes: noise.length ? ['子串噪声复核：' + noise.join('、')] : [], spec: null
      });
    }
    if (pc.replaceHits.length) {
      const r = pc.replaceHits[0];
      return writeJSON(res, 200, {
        ok: true, action: 'exists',
        conclusion: `「${word}」与 ${acc.rowCode(r)} ${acc.rowName(r)} 为统一替换词等价写法，匹配时自动等价，无需重复录入同义词。`,
        rows: [fmtRow(acc, r)], notes: noise.length ? ['子串噪声复核：' + noise.join('、')] : [], spec: null
      });
    }

    // 步骤 3~6：大模型判定（校验失败自动带反馈重试一次）
    const ctx = buildContext(word);
    let llm = null, result = null, lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      llm = await callLLM(word, ctx, attempt ? lastErr : null);
      const action = String(llm.action || '').trim();
      if (action === 'synonym') result = assembleSynonym(word, String(llm.target_code || '').trim());
      else if (action === 'add') result = assembleAdd(word, llm.rows);
      else { // uncertain
        return writeJSON(res, 200, {
          ok: true, action: 'uncertain',
          conclusion: String(llm.conclusion || '无法确定该词的归属，请提供更具体的产品词或补充说明。'),
          rows: [], notes: (llm.notes || []).concat(noise.length ? ['子串噪声复核：' + noise.join('、')] : []), spec: null
        });
      }
      if (!result.error) break;
      lastErr = result.error; result = null;
    }
    if (!result) return writeJSON(res, 422, { ok: false, error: lastErr });
    try { require('fs').writeFileSync(path.join(__dirname, '../../_io/addprod_last_llm.json'), JSON.stringify(llm, null, 2)); } catch (e) { /* 调试日志失败忽略 */ }

    const llmNotes = Array.isArray(llm.notes) ? llm.notes.map(String) : [];
    if (noise.length) llmNotes.push('子串噪声复核（库内最长匹配，一般不阻断）：' + noise.join('、'));
    return writeJSON(res, 200, {
      ok: true, action: result.action,
      conclusion: String(llm.conclusion || '').trim() + ' ' + result.conclusion,
      rows: result.rows, notes: llmNotes, spec: result.spec
    });
  } catch (err) {
    console.error('[addprod] error:', (err && err.stack) || err);
    return writeJSON(res, 500, { ok: false, error: err.message || '服务器内部错误' });
  }
};
