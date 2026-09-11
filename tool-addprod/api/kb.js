// =====================================================================
// 知识库浏览接口（GET /api/addprod/kb）
// 返回【结构化】/【层级】sheet 分页数据（sheet=struct|level，默认 struct，
// 支持 编号/名称/同义词/行业大类 包含搜索）+ 快照信息
// =====================================================================

const path = require('path');
const KB = require(path.join(__dirname, 'kb_data.js'));

module.exports = async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1);
  let size = parseInt(u.searchParams.get('size') || '100', 10) || 100;
  size = Math.min(500, Math.max(10, size));
  const q = (u.searchParams.get('q') || '').trim();
  const sheet = u.searchParams.get('sheet') === 'level' ? 'level' : 'struct';

  try {
    const data = sheet === 'level' ? KB.pageLevel(q, page, size) : KB.pageStruct(q, page, size);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, sheet, ...data, snapshot: KB.snapshot() }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: err.message || '服务器内部错误' }));
  }
};
