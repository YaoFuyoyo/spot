// =====================================================================
// 一次性迁移脚本：把 skills/product-taxonomy-supplement/references/
// 产品分类知识库.xlsx（【结构化】sheet）导入 SQLite 知识库。
// 用法：node tool-addprod/api/seed_db.js [--db <库文件路径>]
// 可重复执行（全量重建：先清空 product/meta 再导入）。
// =====================================================================

const fs = require('fs');
const path = require('path');
const XLSX = require(path.join(__dirname, '../../common/vendor/xlsx.full.min.js'));

const KB = require(path.join(__dirname, 'kb_data.js'));

// 命令行 --db 覆盖目标库路径
const argv = process.argv.slice(2);
let dbPath = KB.DEFAULT_DB;
const i = argv.indexOf('--db');
if (i >= 0 && argv[i + 1]) dbPath = path.resolve(argv[i + 1]);

console.log('源 Excel:', KB.DEFAULT_KB);
console.log('目标库  :', dbPath);

// 1) 读取 Excel【结构化】sheet（主数据）与【层级】sheet（用于补漏校验）
const wb = XLSX.read(fs.readFileSync(KB.DEFAULT_KB), { type: 'buffer' });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets['结构化'], { header: 1, raw: false, defval: '' });
const levelAoa = XLSX.utils.sheet_to_json(wb.Sheets['层级'], { header: 1, raw: false, defval: '' });

// 2) 打开库并清空重建
const { DatabaseSync } = require('node:sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const d = new DatabaseSync(dbPath);
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

function pad(n) { return String(n).padStart(2, '0'); }
const now = new Date();
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

try {
  d.exec('BEGIN IMMEDIATE');
  d.exec('DELETE FROM product');
  d.exec('DELETE FROM meta');

  const ins = d.prepare('INSERT INTO product (code, name, level, industry, synonyms) VALUES (?, ?, ?, ?, ?)');
  let rows = 0, bad = [];
  for (let r = 1; r < aoa.length; r++) {
    const a = aoa[r] || [];
    const code = String(a[0] == null ? '' : a[0]).trim();
    const name = String(a[1] == null ? '' : a[1]).trim();
    const level = parseInt(a[2], 10);
    const industry = String(a[3] == null ? '' : a[3]).trim();
    const synonyms = String(a[4] == null ? '' : a[4]).trim();
    if (!code || !Number.isFinite(level)) { bad.push(`第${r + 1}行: ${JSON.stringify(a).slice(0, 80)}`); continue; }
    ins.run(code, name, level, industry, synonyms);
    rows++;
  }

  // 补漏：【层级】sheet 中存在、但【结构化】缺失的 4 级行（源文件历史维护不一致）
  // 层级名称单元格格式为「主名：同义词1；同义词2」，按第一个全角冒号拆分
  const seenCodes = new Set(d.prepare('SELECT code FROM product').all().map(x => x.code));
  let repaired = 0;
  for (let r = 1; r < levelAoa.length; r++) {
    const a = levelAoa[r] || [];
    const code4 = String(a[6] == null ? '' : a[6]).trim();
    if (!code4 || seenCodes.has(code4)) continue;
    const full = String(a[7] == null ? '' : a[7]).trim();
    const sep = full.indexOf('：');
    const name = sep >= 0 ? full.slice(0, sep).trim() : full;
    const synonyms = sep >= 0 ? full.slice(sep + 1).trim() : '';
    const industry = String(a[8] == null ? '' : a[8]).trim();
    ins.run(code4, name, 4, industry, synonyms);
    seenCodes.add(code4);
    repaired++;
    console.log(`补漏: ${code4} ${name}（层级 sheet 有、结构化缺失，行业 ${industry || '-'}）`);
  }

  d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', ?)`).run(stamp);
  d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded_from', ?)`).run(KB.DEFAULT_KB);
  d.exec('COMMIT');

  const c = k => d.prepare(`SELECT COUNT(*) AS c FROM product WHERE level = ${k}`).get().c;
  const total = d.prepare('SELECT COUNT(*) AS c FROM product').get().c;
  console.log(`导入完成: 共 ${total} 行（1级 ${c(1)} / 2级 ${c(2)} / 3级 ${c(3)} / 4级 ${c(4)}），其中自动补漏 ${repaired} 行`);
  if (bad.length) {
    console.log(`跳过异常行 ${bad.length} 条:`);
    bad.slice(0, 10).forEach(x => console.log('  ' + x));
  }
  console.log('备份口径提示: 【层级】sheet 不入库，由 product 表按归属链实时推导');
} catch (err) {
  try { d.exec('ROLLBACK'); } catch (e) { /* 回滚失败忽略 */ }
  console.error('导入失败:', err.message);
  process.exitCode = 1;
} finally {
  d.close();
}
