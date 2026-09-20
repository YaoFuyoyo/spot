#!/usr/bin/env bash
# ============================================================
#  WSL / Linux 一键启动脚本 (开发模式, 不依赖 systemd)
#  特性:
#    - 自动激活 nvm 的 Node 22
#    - 自动创建 tool-addchain 占位
#    - 端口可通过参数/环境变量指定
#    - 后台模式 + 健康检查 + LAN IP 打印
#
#  用法 (PORT 优先级: 第 2 参数 > PORT 环境变量 > 内置默认 9999):
#
#     # 开发 (前台)
#     bash dev_start.sh                         # 默认 9999
#     bash dev_start.sh 8085                    # 指定 8085
#     PORT=8085 bash dev_start.sh               # 同上
#
#     # 生产后台 + 健康检查
#     bash dev_start.sh bg 8085
#     PORT=80 sudo bash dev_start.sh bg         # 80 端口需 root
#
#     # 控制
#     bash dev_start.sh stop
#     bash dev_start.sh status [PORT]
#     bash dev_start.sh restart [PORT]
#     bash dev_start.sh logs
# ============================================================
set -e

cd "$(dirname "$0")"

# ---------- 端口解析 ----------
DEFAULT_PORT=9999
PORT="${2:-$PORT}"
PORT="${PORT:-$DEFAULT_PORT}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo -e "\033[31m[FAIL]\033[0m 端口非法: $PORT (需 1-65535)"
  exit 1
fi

# ---------- 颜色 ----------
color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[INFO] $*"; }
ok()    { color "32" "[ OK ] $*"; }
err()   { color "31" "[FAIL] $*"; }
warn()  { color "33" "[WARN] $*"; }

# ---------- 1. Node 22 ----------
ensure_node22() {
  # 加载 nvm
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
  fi
  if command -v nvm >/dev/null 2>&1; then
    if ! nvm ls 22 >/dev/null 2>&1; then
      info "通过 nvm 安装 Node 22"
      nvm install 22
    fi
    nvm use 22 >/dev/null
    ok "Node: $(node -v)"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    local v; v=$(node -v | sed 's/v//' | cut -d. -f1)
    if (( v >= 22 )); then ok "Node $(node -v) OK"; return; fi
    err "Node $v < 22, 但无 nvm. 请: nvm install 22 或 sudo apt install -y nodejs"
    exit 1
  fi
  err "未找到 node. 请先: nvm install 22 或 sudo apt install -y nodejs"
  exit 1
}

# ---------- 2. tool-addchain 占位 ----------
ensure_addchain_stub() {
  if [[ ! -d tool-addchain/api ]]; then
    warn "tool-addchain/api 不存在, 创建占位 handler"
    mkdir -p tool-addchain/api
    cat > tool-addchain/api/addchain.js <<'EOF'
// 占位 handler —— 接入 tool-addchain 后删掉这个文件即可
module.exports = async function handler(req, res) {
  res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'tool-addchain 暂未接入' }));
};
EOF
    ok "已创建 tool-addchain/api/addchain.js 占位"
  fi
}

# ---------- 3. 端口占用检测 ----------
check_port() {
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -E "[:.]$PORT\$" >/dev/null; then
      err "端口 $PORT 已被占用 (用 ss -lnt | grep $PORT 看谁在用)"
      exit 1
    fi
  fi
}

# ---------- 4. 80 端口权限检查 ----------
check_root_if_needed() {
  if (( PORT < 1024 )) && [[ $EUID -ne 0 ]]; then
    err "端口 $PORT < 1024 需要 root, 请用: sudo bash dev_start.sh $* $PORT"
    exit 1
  fi
}

# ---------- 5. 启停 ----------
start_bg() {
  check_port
  pkill -f "node .*server.js" 2>/dev/null || true
  sleep 1

  # 关键: 把端口透传给 server.js (通过环境变量 PORT)
  PORT="$PORT" nohup node server.js "$PORT" > server.log 2>&1 &
  echo $! > .server.pid

  # 等待启动并自检
  local i
  for i in 1 2 3 4 5; do
    sleep 1
    if kill -0 "$(cat .server.pid)" 2>/dev/null; then
      # 用本机 127.0.0.1 探测一次, 确认真的起来了
      if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
        ok "server.js 后台启动, PID=$(cat .server.pid), PORT=$PORT"
        info "日志: tail -f server.log"
        show_banner
        return
      fi
    else
      err "进程已退出, 看 server.log"
      tail -n 30 server.log
      exit 1
    fi
  done
  warn "进程在跑但端口尚未就绪, 看 server.log"
  tail -n 20 server.log
}

start_fg() {
  check_port
  info "前台启动 PORT=$PORT (Ctrl+C 退出)"
  exec node server.js "$PORT"
}

stop() {
  local p="${PORT:-$DEFAULT_PORT}"
  if [[ -f .server.pid ]]; then
    local pid; pid=$(cat .server.pid)
    kill "$pid" 2>/dev/null || true
    rm -f .server.pid
    ok "已停止 PID=$pid (port=$p)"
  else
    pkill -f "node .*server.js" 2>/dev/null || true
    ok "已清理所有 server.js 进程"
  fi
}

show_banner() {
  info "访问入口:"
  printf "         本机:   http://127.0.0.1:%s/tool-addprod/addprod.html\n" "$PORT"
  for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.'); do
    printf "         局域网: http://%s:%s/tool-addprod/addprod.html\n" "$ip" "$PORT"
  done
}

status() {
  local p="${1:-$PORT}"
  local url="http://127.0.0.1:${p}/tool-addprod/addprod.html"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" || echo "DOWN")
  info "[$p] 前端页面: HTTP $code  ($url)"

  local api
  api=$(curl -s --max-time 5 "http://127.0.0.1:${p}/api/addprod/kb?page=1&size=1" || echo "")
  if echo "$api" | head -c 1 | grep -q '{'; then
    ok "[$p] API /api/addprod/kb 返回 JSON"
  else
    err "[$p] API 未返回 JSON: $(echo "$api" | head -c 100)"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl status addprod-web --no-pager 2>/dev/null | head -n 4 || true
  fi
  show_banner
}

logs() {
  if [[ -f server.log ]]; then
    tail -n 100 -f server.log
  else
    err "无 server.log, 请先 bg 启动"
  fi
}

# ---------- main ----------
ensure_node22
ensure_addchain_stub

ACTION="${1:-fg}"
case "$ACTION" in
  fg|start)  check_root_if_needed; start_fg ;;
  bg)        check_root_if_needed; start_bg ;;
  stop)      stop ;;
  status)    status "${2:-}" ;;
  restart)   stop; check_root_if_needed; start_bg ;;
  logs)      logs ;;
  *) cat <<EOF
Usage: $0 {fg|bg|stop|status|restart|logs} [PORT]

Examples:
  $0                     # 默认端口 9999 前台
  $0 8085                # 端口 8085 前台
  $0 bg 8085             # 端口 8085 后台
  PORT=80 sudo $0 bg     # 80 端口需 root
  $0 status 8085         # 检查 8085 端口
EOF
    exit 1 ;;
esac
