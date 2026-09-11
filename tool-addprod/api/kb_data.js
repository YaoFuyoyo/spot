// =====================================================================
// 产品分类知识库服务（tool-addprod 内部共享模块，非接口）
// 存储层：SQLite（Node 内置 node:sqlite，零依赖）。
// 原 skills/product-taxonomy-supplement/references/产品分类知识库.xlsx
// 通过 seed_db.js 一次性迁移入库（该 Excel 保留作为迁移源与导出模板）：
//   - product 表 = 原【结构化】sheet（编号/名称/层级/行业大类/同义词）
//   - 原【层级】sheet 不再单独存储，由 product 表按归属链实时推导，永远同步
//   - 统一替换词规则、存在性预检、归属链/子级/下一编码查询、事务化落表、自动备份
// 库文件路径可用环境变量 ADDPROD_DB_PATH 覆盖（默认 项目根/data/addprod.sqlite）
// =====================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = (process.env.ADDPROD_DB_PATH || '').trim()
  || path.join(__dirname, '../../data/addprod.sqlite');
// 迁移源 / 导出模板（保留原 Excel 路径供 seed_db.js 与 export.js 使用）
const DEFAULT_KB = path.join(__dirname, '../../skills/product-taxonomy-supplement/references/产品分类知识库.xlsx');

// 维护手册「统一替换词规则」：组内词汇在全产品范围内可相互替换匹配
const REPLACE_GROUPS = {
  设备类: ['机械', '机器', '设备', '装备', '装置', '仪器', '器材', '器具', '器械'],
  配件类: ['零件', '配件', '附件', '部件', '配套件', '零部件', '零配件'],
  元件类: ['元件', '器件', '元器件'],
  连接词: ['和', '与', '及']
};

function intCode(v) {
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 统一替换词展开（query_kb.py replace_variants） */
function replaceVariants(word) {
  const out = new Set([word]);
  for (const group of Object.values(REPLACE_GROUPS)) {
    for (const g of group) {
      if (word.includes(g)) for (const alt of group) out.add(word.replace(g, alt));
    }
  }
  return [...out].sort();
}

/** 同义词字符串 -> 列表（中英文分号均兼容） */
function synList(s) {
  return String(s || '').replace(/；/g, ';').split(';').map(x => x.trim()).filter(Boolean);
}

/** 【层级】节点名称写法：主名：同义词1；同义词2（apply_kb.py fmt_node） */
function fmtNode(name, syn) {
  const syns = synList(syn);
  return name + (syns.length ? '：' + syns.join('；') : '');
}

function formatTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ===================== 连接与初始化 =====================
const SQL_ROW = 'SELECT code, name, level, industry, synonyms FROM product';

function openDb(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE IF NOT EXISTS product (
      code     TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      level    INTEGER NOT NULL,
      industry TEXT NOT NULL DEFAULT '',
      synonyms TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_product_level ON product(level);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return d;
}

let _db = null;
function conn() {
  if (!_db) _db = openDb(DEFAULT_DB);
  return _db;
}

/** 行数据便捷访问（row = [编号,名称,层级,行业大类,同义词]） */
function rowCode(r) { return String(r[0]).trim(); }
function rowName(r) { return String(r[1]).trim(); }
function rowLevel(r) { return parseInt(r[2], 10) || 0; }
function rowIndustry(r) { return String(r[3]).trim(); }
function rowSyn(r) { return String(r[4] || '').trim(); }
const rowAccessors = { rowCode, rowName, rowLevel, rowIndustry, rowSyn };

function toRow(r) { return [r.code, r.name, r.level, r.industry, r.synonyms]; }

/** 打开用于单次操作的库连接（opts.kbPath 为副本库路径时使用，用后须 close） */
function opDb(dbPath) {
  return (!dbPath || dbPath === DEFAULT_DB) ? { d: conn(), own: false } : { d: openDb(dbPath), own: true };
}

// ===================== 查询（对应 query_kb.py 子命令） =====================

/** check：存在性/冲突/噪声预检 */
function precheck(word, dbPath) {
  const { d, own } = opDb(dbPath);
  const rows = d.prepare(SQL_ROW + ' ORDER BY code').all().map(toRow);
  if (own) d.close();
  const variants = replaceVariants(word).filter(v => v !== word);
  const variantSet = new Set(replaceVariants(word));
  const exact = [], asSynonym = [], replaceHits = [], containedIn = [];
  for (const r of rows) {
    const name = rowName(r), syns = synList(rowSyn(r));
    if (name === word) exact.push(r);
    else if (syns.includes(word)) asSynonym.push(r);
    else if (variantSet.has(name) || syns.some(s => variantSet.has(s))) replaceHits.push(r);
    else if (name.includes(word)) containedIn.push(r);
  }
  return { word, exact, asSynonym, variants, replaceHits, containedIn };
}

/** find：按关键词（含替换词展开）检索 名称+同义词+编号 */
function findByKeyword(word, cap, dbPath) {
  const { d, own } = opDb(dbPath);
  const keys = replaceVariants(word);
  const conds = [], params = [];
  for (const k of keys) {
    conds.push('instr(name, ?) > 0'); params.push(k);
    conds.push('instr(synonyms, ?) > 0'); params.push(k);
    conds.push('instr(code, ?) > 0'); params.push(k);
  }
  const hit = d.prepare(`${SQL_ROW} WHERE ${conds.join(' OR ')}`).all(...params).map(toRow);
  if (own) d.close();
  hit.sort((a, b) => rowName(a).length - rowName(b).length);
  return hit.slice(0, cap || 30);
}

/** path：1→4 级归属链 */
function pathChain(code, dbPath) {
  const { d, own } = opDb(dbPath);
  const chain = [];
  for (const ln of [2, 4, 6, 8]) {
    if (String(code).length < ln) break;
    const r = d.prepare(SQL_ROW + ' WHERE code = ?').get(String(code).slice(0, ln));
    if (r) chain.push(toRow(r));
  }
  if (own) d.close();
  return chain;
}

/** children：直接子级（按编号升序） */
function children(code, dbPath) {
  const { d, own } = opDb(dbPath);
  const wantLen = String(code).length + 2;
  const rows = d.prepare(`${SQL_ROW} WHERE length(code) = ? AND code LIKE ? || '%' ORDER BY CAST(code AS INTEGER)`)
    .all(wantLen, String(code)).map(toRow);
  if (own) d.close();
  return rows;
}

/** next：下一个可用同级编码（每级上限 99）；used 为批次内已占用编码 */
function nextCode(parent, used, dbPath) {
  const { d, own } = opDb(dbPath);
  const wantLen = String(parent).length + 2;
  const r = d.prepare(`
    SELECT COALESCE(MAX(CAST(substr(code, ?) AS INTEGER)), 0) AS m
    FROM product WHERE length(code) = ? AND code LIKE ? || '%'`)
    .get(String(parent).length + 1, wantLen, String(parent));
  if (own) d.close();
  let nxt = (r.m || 0) + 1;
  const taken = new Set(used || []);
  while (taken.has(parent + pad2(nxt))) nxt++;
  if (nxt > 99) return { error: `父级 ${parent} 下同级已满 99 个，无法继续分配（每级上限 99）` };
  return { code: parent + pad2(nxt), level: wantLen / 2, siblingCount: r.m || 0 };
}

function levelList(lv, dbPath) {
  const { d, own } = opDb(dbPath);
  const rows = d.prepare(`${SQL_ROW} WHERE level = ? ORDER BY CAST(code AS INTEGER)`).all(lv).map(toRow);
  if (own) d.close();
  return rows;
}

/** l1：全部一级节点（编号升序） */
function l1List(dbPath) { return levelList(1, dbPath); }

/** l2：全部二级节点（编号升序，供提示词根父级清单） */
function l2List(dbPath) { return levelList(2, dbPath); }

/** 快照信息（对应 query_kb.py info；层级行数 = 4 级产品数，即推导后的【层级】行数） */
function snapshot(dbPath) {
  const { d, own } = opDb(dbPath);
  const structRows = d.prepare('SELECT COUNT(*) AS c FROM product').get().c;
  const levelRows = d.prepare('SELECT COUNT(*) AS c FROM product WHERE level = 4').get().c;
  const level1Count = d.prepare('SELECT COUNT(*) AS c FROM product WHERE level = 1').get().c;
  let modified = null;
  try { modified = d.prepare(`SELECT value FROM meta WHERE key = 'updated_at'`).get(); } catch (e) { /* 表未建时忽略 */ }
  if (own) d.close();
  const p = dbPath || DEFAULT_DB;
  if (!modified || !modified.value) {
    try { modified = { value: formatTime(fs.statSync(p).mtimeMs) }; }
    catch (e) { modified = { value: '' }; }
  }
  return { kbPath: p, structRows, levelRows, level1Count, modified: modified.value };
}

/** 【结构化】分页 + 搜索（编号/名称/同义词 包含匹配） */
function pageStruct(q, page, size, dbPath) {
  const { d, own } = opDb(dbPath);
  let where = '', params = [];
  if (q && String(q).trim()) {
    where = ' WHERE instr(LOWER(code || name || synonyms), ?) > 0';
    params.push(String(q).trim().toLowerCase());
  }
  const total = d.prepare(`SELECT COUNT(*) AS c FROM product${where}`).get(...params).c;
  const rows = d.prepare(`${SQL_ROW}${where} ORDER BY CAST(code AS INTEGER) LIMIT ? OFFSET ?`)
    .all(...params, size, (Math.max(1, page) - 1) * size).map(toRow);
  if (own) d.close();
  return {
    total, page: Math.max(1, page), size,
    rows: rows.map(r => [rowCode(r), rowName(r), rowLevel(r), rowIndustry(r), rowSyn(r)])
  };
}

/** 【层级】分页 + 搜索（由 product 表按归属链实时推导，与 snapshot.levelRows 口径一致） */
function pageLevel(q, page, size, dbPath) {
  const { d, own } = opDb(dbPath);
  const fmt = col => `${col}.name || CASE WHEN TRIM(${col}.synonyms) <> '' THEN '：' || TRIM(${col}.synonyms) ELSE '' END`;
  const inner = `
    SELECT substr(p4.code, 1, 2) AS c1, ${fmt('p1')} AS n1,
           substr(p4.code, 1, 4) AS c2, ${fmt('p2')} AS n2,
           substr(p4.code, 1, 6) AS c3, ${fmt('p3')} AS n3,
           p4.code AS c4, ${fmt('p4')} AS n4, p4.industry AS ind
    FROM product p4
    JOIN product p1 ON p1.code = substr(p4.code, 1, 2)
    JOIN product p2 ON p2.code = substr(p4.code, 1, 4)
    JOIN product p3 ON p3.code = substr(p4.code, 1, 6)
    WHERE p4.level = 4`;
  let where = '', params = [];
  if (q && String(q).trim()) {
    where = ' WHERE instr(LOWER(c1 || n1 || c2 || n2 || c3 || n3 || c4 || n4 || ind), ?) > 0';
    params.push(String(q).trim().toLowerCase());
  }
  const total = d.prepare(`SELECT COUNT(*) AS c FROM (${inner})${where}`).get(...params).c;
  const rows = d.prepare(`SELECT * FROM (${inner})${where} ORDER BY c4 LIMIT ? OFFSET ?`)
    .all(...params, size, (Math.max(1, page) - 1) * size);
  if (own) d.close();
  const cell = (c, n) => (c ? c + ' ' + n : n);
  return {
    total, page: Math.max(1, page), size,
    rows: rows.map(r => [cell(r.c1, r.n1), cell(r.c2, r.n2), cell(r.c3, r.n3), cell(r.c4, r.n4), r.ind])
  };
}

// ===================== 落表（对应 apply_kb.py，含 dry-run/备份/事务化写入） =====================

/**
 * 落表：spec = { synonyms:[{code,syn}], add:[{code,name,level,industry,syn}] }
 * 返回 summary；dryRun=true 时只校验计算不写入。
 * 全部变更先校验后在一个事务内应用；写入前 VACUUM INTO 自动备份整库。
 */
function archive(spec, opts) {
  opts = opts || {};
  const dbPath = opts.kbPath || DEFAULT_DB;
  const dryRun = !!opts.dryRun;
  const { d, own } = opDb(dbPath);

  const summary = { dryRun, synonyms: [], add: [], skipped: [] };
  const stmtGet = d.prepare(SQL_ROW + ' WHERE code = ?');
  const batch = new Map();     // 本批次可见状态: code -> row（含已有行的同义词更新与全部新增）
  const newCodes = [];         // 本批次新增的编号（用于插入位置/层级行数推算）
  const synUpdates = [];       // 待应用: {code, newSyn}
  const inserts = [];          // 待应用: row

  // ---------- 1) 同义词挂入 ----------
  for (const item of spec.synonyms || []) {
    const code = String(item.code || '').trim();
    const syn = String(item.syn || '').trim();
    let r = batch.get(code);
    if (!r) { const g = stmtGet.get(code); if (g) r = toRow(g); }
    if (!r) { summary.skipped.push(`编号 ${code} 不存在`); continue; }
    const cur = synList(r[4]);
    if (cur.includes(syn)) { summary.skipped.push(`${code} 已含同义词「${syn}」`); continue; }
    cur.push(syn);
    const newSyn = cur.join('；');
    const updated = r.slice(); updated[4] = newSyn;
    batch.set(code, updated);
    synUpdates.push({ code, newSyn });
    // 受影响的【层级】行数 = 该节点（含自身为 4 级时）子树下的 4 级产品行数
    let l4 = d.prepare(`SELECT COUNT(*) AS c FROM product WHERE level = 4 AND code LIKE ? || '%'`).get(code).c;
    l4 += newCodes.filter(c => String(c).length === 8 && c.startsWith(code)).length;
    summary.synonyms.push({ code, name: rowName(r), newSyn, levelRowsUpdated: l4 });
  }

  // ---------- 2) 新增节点（按编码升序，保证插入位置递推正确） ----------
  const adds = (spec.add || []).slice().sort((a, b) => (intCode(a.code) || 0) - (intCode(b.code) || 0));
  for (const item of adds) {
    const code = String(item.code || '').trim();
    const lvl = parseInt(item.level, 10);
    const existRow = batch.get(code) || (stmtGet.get(code) ? toRow(stmtGet.get(code)) : null);
    if (existRow) { summary.skipped.push(`编号 ${code} 已存在：${rowName(existRow)}`); continue; }
    if (!Number.isFinite(lvl) || code.length !== lvl * 2) { summary.skipped.push(`${code} 长度与层级 ${item.level} 不符（应为 ${lvl * 2} 位）`); continue; }
    const parent = code.slice(0, -2);
    const parentRow = parent ? (batch.get(parent) || (stmtGet.get(parent) ? toRow(stmtGet.get(parent)) : null)) : null;
    if (parent && !parentRow) { summary.skipped.push(`${code} 的父级 ${parent} 不存在`); continue; }
    const industry = String(item.industry || '').trim() || (parent ? rowIndustry(parentRow) : '');
    const name = String(item.name || '').trim();
    const syn = String(item.syn || '').trim();

    // 插入位置（按 int(编号) 升序）：位置 = 小于新编号的行数 + 1（含本批次已排定的新增）
    const n = intCode(code);
    let less = d.prepare('SELECT COUNT(*) AS c FROM product WHERE CAST(code AS INTEGER) < ?').get(n).c;
    less += newCodes.filter(c => (intCode(c) || 0) < n).length;
    const beforeRow = d.prepare('SELECT code FROM product WHERE CAST(code AS INTEGER) < ? ORDER BY CAST(code AS INTEGER) DESC LIMIT 1').get(n);
    const afterRow = d.prepare('SELECT code FROM product WHERE CAST(code AS INTEGER) > ? ORDER BY CAST(code AS INTEGER) ASC LIMIT 1').get(n);

    const row = [code, name, lvl, industry, syn];
    batch.set(code, row);
    newCodes.push(code);
    inserts.push(row);
    summary.add.push({
      code, name, level: lvl, industry, syn,
      structRow: less + 1,
      before: beforeRow ? beforeRow.code : null,
      after: afterRow ? afterRow.code : null,
      levelRow: null
    });
  }

  if (dryRun) { if (own) d.close(); return summary; }
  if (synUpdates.length || inserts.length) {
    // ---------- 备份（整库快照，固定文件名每次覆盖，避免目录无限增长） ----------
    const bak = dbPath.replace(/\.sqlite$/i, '.bak.sqlite');
    fs.rmSync(bak, { force: true }); // VACUUM INTO 要求目标文件不存在
    d.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    summary.backup = bak;

    // ---------- 事务化写入 ----------
    try {
      d.exec('BEGIN IMMEDIATE');
      const ins = d.prepare('INSERT INTO product (code, name, level, industry, synonyms) VALUES (?, ?, ?, ?, ?)');
      for (const r of inserts) ins.run(...r);
      const upd = d.prepare('UPDATE product SET synonyms = ? WHERE code = ?');
      for (const u of synUpdates) upd.run(u.newSyn, u.code);
      d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', ?)`).run(formatTime(Date.now()));
      d.exec('COMMIT');
    } catch (err) {
      try { d.exec('ROLLBACK'); } catch (e) { /* 回滚失败忽略 */ }
      if (own) d.close();
      throw err;
    }
  }
  summary.saved = dbPath;
  if (own) d.close();
  return summary;
}

module.exports = {
  DEFAULT_DB, DEFAULT_KB, REPLACE_GROUPS,
  replaceVariants, synList, fmtNode,
  precheck, findByKeyword, pathChain, children, nextCode,
  l1List, l2List, snapshot, pageStruct, pageLevel, archive,
  // 便于接口层组装展示行
  rowAccessors: { rowCode, rowName, rowLevel, rowIndustry, rowSyn }
};
