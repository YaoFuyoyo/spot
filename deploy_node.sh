#!/usr/bin/env bash
# =============================================================
#  Node.js 全栈站点部署脚本 (Linux) —— 适配带 /api 的前端项目
#  自动: 安装 Node22+ → 拉代码 → 安装依赖 → systemd 守护 → 开防火墙
#  用法:
#     sudo ./deploy_node.sh install    [PORT=8085]
#     sudo ./deploy_node.sh restart    [PORT=8085]
#     sudo ./deploy_node.sh status     [PORT=8085]
#     sudo ./deploy_node.sh logs
#     sudo ./deploy_node.sh uninstall
# =============================================================
set -euo pipefail

# ---------- 可配置 ----------
APP_NAME="${APP_NAME:-addprod-web}"
SITE_PORT="${PORT:-8085}"
APP_DIR="/opt/${APP_NAME}"
SRC_DIR="$(pwd)"                        # 当前目录 = 项目根(server.js 所在)
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
NODE_MIN_MAJOR=22     # server.js 用 node:sqlite, 必须 22+
# -------------------------

# 解析位置参数
ACTION="${1:-install}"
[[ "${2:-}" =~ ^PORT=([0-9]+)$ ]] && SITE_PORT="${BASH_REMATCH[1]}"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[INFO] $*"; }
ok()    { color "32" "[ OK ] $*"; }
warn()  { color "33" "[WARN] $*"; }
err()   { color "31" "[FAIL] $*"; }

# 端口合法性
if ! [[ "${SITE_PORT}" =~ ^[0-9]+$ ]] || (( SITE_PORT < 1 || SITE_PORT > 65535 )); then
  err "端口非法: ${SITE_PORT}"; exit 1
fi

# ---------- 检测包管理器 ----------
detect_pkg_mgr() {
  if   command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v yum     >/dev/null 2>&1; then echo "yum"
  elif command -v dnf     >/dev/null 2>&1; then echo "dnf"
  else err "未检测到 apt/yum/dnf"; exit 1
  fi
}

# ---------- 安装 Node.js ----------
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local ver; ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if (( ver >= NODE_MIN_MAJOR )); then
      ok "Node 已就绪: $(node -v)"; return
    fi
  fi
  info "安装 Node.js ${NODE_MIN_MAJOR}+"
  case "$(detect_pkg_mgr)" in
    apt)
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
      ;;
    yum|dnf)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      $PKG_MGR install -y nodejs
      ;;
  esac
  ok "Node 已安装: $(node -v)"
}

# ---------- 同步代码 ----------
sync_code() {
  info "同步代码到 ${APP_DIR}"
  mkdir -p "${APP_DIR}"
  rsync -a --delete \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='*.log' \
        "${SRC_DIR}/" "${APP_DIR}/"
  ok "代码同步完成"
}

# ---------- 安装依赖 ----------
install_deps() {
  cd "${APP_DIR}"
  if [[ -f package.json ]]; then
    info "安装 npm 依赖"
    npm install --omit=dev --no-audit --no-fund
  else
    info "无 package.json, 仅安装项目运行时依赖 (better-sqlite3 / xlsx 等)"
    npm init -y >/dev/null
    npm install --omit=dev --no-audit --no-fund \
        better-sqlite3 xlsx express 2>/dev/null || true
  fi
  ok "依赖安装完成"
}

# ---------- systemd 守护 ----------
write_systemd() {
  info "写入 systemd: ${SERVICE_FILE}"
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=${APP_NAME} (Node.js static + api)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${SITE_PORT}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3
User=root
LimitNOFILE=65535
StandardOutput=append:/var/log/${APP_NAME}.log
StandardError=append:/var/log/${APP_NAME}.log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${APP_NAME}" >/dev/null
  systemctl restart "${APP_NAME}"
  ok "服务已注册到 systemd"
}

# ---------- 防火墙 ----------
open_firewall() {
  info "尝试开放端口 ${SITE_PORT}/tcp"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${SITE_PORT}/tcp" comment "${APP_NAME}"
    ok "ufw 已放行"
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${SITE_PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld 已放行"
  elif command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p tcp --dport "${SITE_PORT}" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT -p tcp --dport "${SITE_PORT}" -j ACCEPT
    ok "iptables 已放行 (重启失效)"
  else
    warn "未找到防火墙工具, 请手动放行 ${SITE_PORT}/tcp"
  fi
}

# ---------- LAN IP ----------
get_lan_urls() {
  local urls=()
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.'); do
      urls+=("http://${ip}:${SITE_PORT}")
    done
  fi
  [[ ${#urls[@]} -eq 0 ]] && command -v ip >/dev/null 2>&1 && \
    urls+=("http://$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -n1):${SITE_PORT}")
  printf '%s\n' "${urls[@]}"
}

# ---------- 状态 ----------
show_status() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${SITE_PORT}" || echo "DOWN")
  info "本地: http://127.0.0.1:${SITE_PORT}  -> HTTP ${code}"

  local urls; urls=$(get_lan_urls)
  [[ -n "$urls" ]] && { info "局域网入口:"; while IFS= read -r u; do printf "         %s\n" "$u"; done <<< "$urls"; }

  # 关键: 测一下 API 是否真的回了 JSON
  local apiResp
  apiResp=$(curl -s --max-time 3 "http://127.0.0.1:${SITE_PORT}/api/addprod/kb?page=1&size=1" || echo "")
  if echo "$apiResp" | head -c 1 | grep -q '{'; then
    ok "API /api/addprod/kb 返回 JSON, 服务正常"
  else
    warn "API 未返回 JSON, 请用 ./deploy_node.sh logs 看错误"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl status "${APP_NAME}" --no-pager 2>/dev/null | head -n 8 || true
  fi
}

# ---------- 各动作 ----------
do_install() {
  [[ $EUID -ne 0 ]] && { err "请用 root: sudo $0 install"; exit 1; }
  ensure_node
  sync_code
  install_deps
  write_systemd
  open_firewall
  sleep 1
  show_status
  ok "部署完成"
}

do_restart() {
  [[ $EUID -ne 0 ]] && { err "请用 root: sudo $0 restart"; exit 1; }
  sync_code
  install_deps
  systemctl restart "${APP_NAME}"
  sleep 1
  show_status
  ok "已重启"
}

do_status() {
  show_status
}

do_logs() {
  [[ -f /var/log/${APP_NAME}.log ]] && tail -n 100 -f /var/log/${APP_NAME}.log \
    || journalctl -u "${APP_NAME}" -n 100 -f
}

do_uninstall() {
  [[ $EUID -ne 0 ]] && { err "请用 root: sudo $0 uninstall"; exit 1; }
  systemctl stop "${APP_NAME}" 2>/dev/null || true
  systemctl disable "${APP_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}"
  systemctl daemon-reload

  if command -v ufw >/dev/null 2>&1; then ufw delete allow "${SITE_PORT}/tcp" 2>/dev/null || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-port="${SITE_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi

  rm -rf "${APP_DIR}"
  rm -f "/var/log/${APP_NAME}.log"
  ok "已卸载 ${APP_NAME}"
}

case "${ACTION}" in
  install)   do_install ;;
  restart)   do_restart ;;
  status)    do_status  ;;
  logs)      do_logs    ;;
  uninstall) do_uninstall ;;
  *) echo "Usage: $0 {install|restart|status|logs|uninstall} [PORT=NNNN]"; exit 1 ;;
esac
