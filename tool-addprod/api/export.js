// =====================================================================
// 知识库导出接口（GET /api/addprod/export）
// 从 SQLite 知识库实时生成 产品分类知识库.xlsx（【结构化】+推导的【层级】双 sheet），
// 按 base64 编码返回，前端在用户点击下载时解码保存。
// 以原 Excel 为模板（保留表头与 sheet 结构）；模板缺失时按标准表头重建。
// =====================================================================

const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '../../common/vendor/xlsx.full.min.js'));
const KB = require(path.join(__dirname, 'kb_data.js'));

const SHEET_STRUCT = '结构化';
const SHEET_LEVEL = '层级';
const STRUCT_HEADER = ['产品编号', '产品名称', '产品层级', '产品行业大类', '产品同义词'];
const LEVEL_HEADER = ['一级编号', '一级名称', '二级编号', '二级名称', '三级编号', '三级名称', '四级编号', '四级名称', '行业大类'];

function writeJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function isTransientIoError(err) {
  return /disk I\/O error|SQLITE_IOERR|database is locked|SQLITE_BUSY|unable to open database|SQLITE_CANTOPEN/i.test(String(err && err.message || err));
}

/**
 * Export can run while an archive transaction has just completed.  A fresh
 * read-only connection is intentionally used and transient SQLite I/O / busy
 * errors are retried; all temporary sort data remains in memory.
 */
function readExportRows() {
  const { DatabaseSync } = require('node:sqlite');
  const fmt = col => `${col}.name || CASE WHEN TRIM(${col}.synonyms) <> '' THEN '：' || TRIM(${col}.synonyms) ELSE '' END`;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    let d;
    try {
      d = new DatabaseSync(KB.DEFAULT_DB, { readOnly: true });
      d.exec('PRAGMA busy_timeout = 10000; PRAGMA temp_store = MEMORY; PRAGMA query_only = ON;');
      const struct = d.prepare('SELECT code, name, level, industry, synonyms FROM product ORDER BY CAST(code AS INTEGER)').all();
      const level = d.prepare(`
        SELECT substr(p4.code, 1, 2) AS c1, ${fmt('p1')} AS n1,
               substr(p4.code, 1, 4) AS c2, ${fmt('p2')} AS n2,
               substr(p4.code, 1, 6) AS c3, ${fmt('p3')} AS n3,
               p4.code AS c4, ${fmt('p4')} AS n4, p4.industry AS ind
        FROM product p4
        JOIN product p1 ON p1.code = substr(p4.code, 1, 2)
        JOIN product p2 ON p2.code = substr(p4.code, 1, 4)
        JOIN product p3 ON p3.code = substr(p4.code, 1, 6)
        WHERE p4.level = 4
        ORDER BY p4.code`).all();
      return { struct, level };
    } catch (err) {
      lastError = err;
      if (!isTransientIoError(err) || attempt === 2) throw err;
    } finally {
      if (d) {
        try { d.close(); } catch (e) { /* close failure must not mask query failure */ }
      }
    }
  }
  throw lastError;
}

module.exports = async function handler(req, res) {
  try {
    // 1) 取模板表头（原 Excel 若存在则沿用其表头行，保持格式一致）
    let structHeader = STRUCT_HEADER, levelHeader = LEVEL_HEADER;
    if (fs.existsSync(KB.DEFAULT_KB)) {
      const wbT = XLSX.read(fs.readFileSync(KB.DEFAULT_KB), { type: 'buffer' });
      if (wbT.Sheets[SHEET_STRUCT]) structHeader = XLSX.utils.sheet_to_json(wbT.Sheets[SHEET_STRUCT], { header: 1, raw: false, defval: '' })[0] || STRUCT_HEADER;
      if (wbT.Sheets[SHEET_LEVEL]) levelHeader = XLSX.utils.sheet_to_json(wbT.Sheets[SHEET_LEVEL], { header: 1, raw: false, defval: '' })[0] || LEVEL_HEADER;
    }

    // 2) 从库中拉全量数据：【结构化】直接读表；【层级】由归属链推导
    const { struct, level } = readExportRows();

    // 3) 组装双 sheet 工作簿
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      structHeader,
      ...struct.map(r => [r.code, r.name, r.level, r.industry, r.synonyms])
    ]), SHEET_STRUCT);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      levelHeader,
      ...level.map(r => [r.c1, r.n1, r.c2, r.n2, r.c3, r.n3, r.c4, r.n4, r.ind])
    ]), SHEET_LEVEL);

    // 4) base64 编码返回（前端点击下载时才解码保存）
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    return writeJSON(res, 200, {
      ok: true,
      filename: '产品分类知识库.xlsx',
      structRows: struct.length,
      levelRows: level.length,
      base64: Buffer.from(buf).toString('base64')
    });
  } catch (err) {
    // 某些托管平台将 SQLite 所在目录挂载为不完全兼容的文件系统，
    // 即使只读 SELECT 也可能报 SQLITE_IOERR。此时退回到只读 Excel 模板，
    // 确保“下载”功能可用；模板不包含本次运行中尚未同步的存档变更。
    if (isTransientIoError(err) && fs.existsSync(KB.DEFAULT_KB)) {
      try {
        const template = fs.readFileSync(KB.DEFAULT_KB);
        console.warn('[ADDPROD EXPORT FALLBACK] SQLite unavailable, returning template:', err.message);
        return writeJSON(res, 200, {
          ok: true,
          filename: '产品分类知识库.xlsx',
          fallback: true,
          warning: '实时知识库暂不可读取，已下载内置知识库模板；本次尚未同步的存档变更不会包含在该文件中。',
          base64: template.toString('base64')
        });
      } catch (fallbackErr) {
        console.error('[ADDPROD EXPORT FALLBACK ERROR]', fallbackErr && fallbackErr.stack ? fallbackErr.stack : fallbackErr);
      }
    }
    // 保留服务端真实错误，前端只展示 error 字段
    console.error('[ADDPROD EXPORT ERROR]', err && err.stack ? err.stack : err);
    return writeJSON(res, 500, { ok: false, error: err.message || '导出失败' });
  }
};
