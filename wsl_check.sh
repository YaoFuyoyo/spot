#!/usr/bin/env bash
# ============================================================
# WSL 环境自检 + 端到端启动 server.js 验证脚本
# 在 WSL 里运行:  cd /mnt/d/git_project/spot && bash wsl_check.sh
# ============================================================
set -e

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[INFO] $*"; }
ok()    { color "32" "[ OK ] $*"; }
err()   { color "31" "[FAIL] $*"; }

info "1. WSL / OS 信息"
uname -a
cat /etc/os-release 2>/dev/null | head -n 5 || true

info "2. Node 版本 (必须 >= 22, 因 server.js 用了 node:sqlite 内置模块)"
node -v 2>/dev/null || err "node 未安装"
NVER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -n "$NVER" && "$NVER" -ge 22 ]]; then
  ok "Node $NVER >= 22 OK"
else
  err "Node 版本 < 22, node:sqlite 用不了, 请升级: 见下方"
fi

info "3. 关键文件/目录"
ls -d tool-addprod tool-addchain data server.js deploy_node.sh 2>&1 | head -n 20

info "4. SQLite 库是否就位"
ls -lh data/addprod.sqlite 2>&1 || err "data/addprod.sqlite 不存在"

info "5. 后台启动 server.js (端口 9999)"
pkill -f "node .*server.js" 2>/dev/null || true
sleep 1
nohup node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 2
echo "PID: $SERVER_PID"
info "6. 启动日志"
cat /tmp/server.log

info "7. 静态页面 (期望 200)"
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 3 http://127.0.0.1:9999/tool-addprod/addprod.html
info "8. API 健康检查 (期望返回 JSON, 首字符 '{')"
RESP=$(curl -s --max-time 5 "http://127.0.0.1:9999/api/addprod/kb?page=1&size=1")
echo "$RESP" | head -c 300; echo
if echo "$RESP" | head -c 1 | grep -q '{'; then
  ok "API 返回 JSON ✓"
else
  err "API 未返回 JSON, 浏览器会报 '<!DOCTYPE' 错误"
  info "服务器日志:"; tail -n 30 /tmp/server.log
fi

info "9. LAN IP (局域网访问入口)"
hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' || true

info "10. 清理"
kill $SERVER_PID 2>/dev/null || true
sleep 1
ok "完成"
