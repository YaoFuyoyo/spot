const http = require('http');
const fs = require('fs');
const path = require('path');

// 本地加载根目录 .env（Node 24 内置 loadEnvFile；仅本地开发时存在，生产环境忽略）
try { require('node:process').loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* .env 不存在时忽略 */ }

// 端口优先级: 命令行参数 > PORT 环境变量 > 9999
// 用法示例: node server.js 8085  或  PORT=8085 node server.js
const PORT = parseInt(
  (process.argv[2] && /^\d+$/.test(process.argv[2]) && process.argv[2]) ||
  process.env.PORT ||
  '9999', 10
);
const HOST = process.env.HOST || '0.0.0.0';   // 0.0.0.0 才能让局域网访问
const ROOT = __dirname;

// 各工具的接口处理器（本地开发时转调，与生产环境共用同一份实现）
const ADDCHAIN_HANDLER = require('./tool-addchain/api/addchain.js');
const UPDOWN_HANDLER = require('./tool-updown/api/updown.js');
const ADDPROD_HANDLER = require('./tool-addprod/api/addprod.js');
const ADDPROD_ARCHIVE_HANDLER = require('./tool-addprod/api/archive.js');
const ADDPROD_KB_HANDLER = require('./tool-addprod/api/kb.js');
const ADDPROD_EXPORT_HANDLER = require('./tool-addprod/api/export.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // 统一 500 JSON 响应
  function json500(res, err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: (err && err.message) || '服务器内部错误' }));
  }

  // 禁止直接访问点文件（如 .env），避免泄露敏感配置
  const pathOnly = (req.url || '').split('?')[0];
  if (pathOnly.split('/').some(seg => seg.length > 0 && seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // ===== 新增产业链接口（转调各工具 api 目录下的处理器） =====
  if (req.method === 'POST' && pathOnly === '/api/addchain') {
    try {
      await ADDCHAIN_HANDLER(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: err.message || '服务器内部错误' }));
    }
    return;
  }

  // ===== 产品上下游关系网接口（转调 tool-updown api 处理器） =====
  if (req.method === 'POST' && pathOnly === '/api/updown') {
    try { await UPDOWN_HANDLER(req, res); }
    catch (err) { json500(res, err); }
    return;
  }

  // ===== 产品补充接口（转调各工具 api 目录下的处理器） =====
  if (req.method === 'POST' && pathOnly === '/api/addprod') {
    try { await ADDPROD_HANDLER(req, res); }
    catch (err) { json500(res, err); }
    return;
  }
  if (req.method === 'POST' && pathOnly === '/api/addprod/archive') {
    try { await ADDPROD_ARCHIVE_HANDLER(req, res); }
    catch (err) { json500(res, err); }
    return;
  }
  if (req.method === 'GET' && pathOnly === '/api/addprod/kb') {
    try { await ADDPROD_KB_HANDLER(req, res); }
    catch (err) { json500(res, err); }
    return;
  }
  if (req.method === 'GET' && pathOnly === '/api/addprod/export') {
    try { await ADDPROD_EXPORT_HANDLER(req, res); }
    catch (err) { json500(res, err); }
    return;
  }

  // 部分部署平台将站点入口暴露为 /app/。该前缀是 URL 前缀而非
  // 磁盘目录；统一映射到项目根目录，兼容 /app、/app/ 和 /app/index.html。
  let staticPath = pathOnly;
  if (staticPath === '/app' || staticPath === '/app/') staticPath = '/index.html';
  else if (staticPath.startsWith('/app/')) staticPath = staticPath.slice(4) || '/index.html';
  const urlPath = decodeURIComponent(staticPath === '/' ? '/index.html' : staticPath);
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + filePath);
      return;
    }
    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    };
    if (ext !== '.xlsx' && ext !== '.xls') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  // 收集 LAN IP 给开发者直观看到局域网入口
  const os = require('os');
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
  }
  console.log('========================================');
  console.log(` 站点服务已启动 (Node ${process.version})`);
  console.log(`   本机:    http://0.0.0.0:${PORT}`);
  ips.forEach(ip => console.log(`   局域网: http://${ip}:${PORT}`));
  console.log(`   目录:   ${ROOT}`);
  console.log('========================================');
});
