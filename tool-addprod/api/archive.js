// =====================================================================
// 存档确认接口（POST /api/addprod/archive）
// 对应 SKILL.md 步骤 8「存档」：先 dry-run 预检插入位置，全部通过后正式写入
// （同义词先于新增、按 int(编号) 升序插入、【层级】双 sheet 同步、自动备份）
// =====================================================================

const path = require('path');
const KB = require(path.join(__dirname, 'kb_data.js'));

const BODY_JSON_LIMIT = 1 * 1024 * 1024;

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

module.exports = async function handler(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return writeJSON(res, 400, { ok: false, error: '请求体须为合法 JSON' }); }

  const spec = body.spec;
  const hasSyn = spec && Array.isArray(spec.synonyms) && spec.synonyms.length;
  const hasAdd = spec && Array.isArray(spec.add) && spec.add.length;
  if (!hasSyn && !hasAdd) return writeJSON(res, 400, { ok: false, error: '没有待写入的变更' });

  try {
    // 1) dry-run 预检：插入位置/父级存在性/编号冲突
    const plan = KB.archive(spec, { dryRun: true });
    if (plan.skipped.length) {
      return writeJSON(res, 422, { ok: false, error: '写入预检未通过，未做任何改动：' + plan.skipped.join('；') });
    }
    if (!plan.synonyms.length && !plan.add.length) {
      return writeJSON(res, 422, { ok: false, error: '没有可写入的变更' });
    }

    // 2) 正式写入（自动备份）
    const summary = KB.archive(spec, { dryRun: false });

    return writeJSON(res, 200, {
      ok: true,
      summary: {
        backup: summary.backup,
        synonyms: summary.synonyms,
        add: summary.add,
        saved: summary.saved
      },
      snapshot: KB.snapshot()
    });
  } catch (err) {
    return writeJSON(res, 500, { ok: false, error: err.message || '服务器内部错误' });
  }
};
