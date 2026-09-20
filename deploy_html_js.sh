#!/usr/bin/env bash
# =============================================================
#  纯 HTML + JS 静态站点部署脚本 (Linux)
#  支持: Ubuntu / Debian / CentOS / RHEL
#  用法:
#     sudo ./deploy_html_js.sh install    [PORT=8085]
#     sudo ./deploy_html_js.sh restart    [PORT=8085]
#     sudo ./deploy_html_js.sh status     [PORT=8085]
#     sudo ./deploy_html_js.sh uninstall  [PORT=8085]
#
#  也支持环境变量覆盖 (优先级: 命令行 > 环境变量 > 内置默认):
#     PORT=9000 SITE_NAME=blog sudo ./deploy_html_js.sh install
# =============================================================
set -euo pipefail

# ---------- 默认参数 (可被 PORT / SITE_NAME 覆盖) ----------
SITE_NAME="${SITE_NAME:-my-static-site}"
SITE_PORT="${PORT:-8085}"            # 默认改为 8085,避开 80 的 default_server 冲突
SITE_DIR="/var/www/${SITE_NAME}"
SRC_DIR="$(pwd)"
NGINX_CONF="/etc/nginx/conf.d/${SITE_NAME}.conf"
SERVICE_USER="www-data"
# --------------------------------

# 解析位置参数: 第一个是动作, 第二个可选 PORT=xxxx
ACTION="${1:-install}"
if [[ "${2:-}" =~ ^PORT=([0-9]+)$ ]]; then
  SITE_PORT="${BASH_REMATCH[1]}"
fi

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[INFO] $*"; }
ok()    { color "32" "[ OK ] $*"; }
warn()  { color "33" "[WARN] $*"; }
err()   { color "31" "[FAIL] $*"; }

# ---------- 端口合法性校验 ----------
if ! [[ "${SITE_PORT}" =~ ^[0-9]+$ ]] || (( SITE_PORT < 1 || SITE_PORT > 65535 )); then
  err "端口非法: ${SITE_PORT} (需 1-65535)"; exit 1
fi

detect_pkg_mgr() {
  if   command -v apt-get >/dev/null 2>&1; then echo "apt"; SERVICE_USER="www-data"
  elif command -v yum     >/dev/null 2>&1; then echo "yum"; SERVICE_USER="nginx"
  elif command -v dnf     >/dev/null 2>&1; then echo "dnf"; SERVICE_USER="nginx"
  else err "未检测到 apt/yum/dnf，请手动安装 nginx"; exit 1
  fi
}

install_nginx() {
  info "使用包管理器: ${PKG_MGR}"
  case "$PKG_MGR" in
    apt) apt-get update -y && apt-get install -y nginx ;;
    yum) yum install -y epel-release && yum install -y nginx ;;
    dnf) dnf install -y nginx ;;
  esac
  ok "Nginx 已安装: $(nginx -v 2>&1)"
}

# ---------- 防火墙配置 ----------
# 不同发行版的防火墙工具不一样, 都尝试一遍
open_firewall() {
  info "尝试开放端口 ${SITE_PORT}/tcp (LAN 访问)"

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${SITE_PORT}/tcp" comment "${SITE_NAME}"
    ok "ufw 已放行 ${SITE_PORT}/tcp"

  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${SITE_PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld 已放行 ${SITE_PORT}/tcp"

  elif command -v iptables >/dev/null 2>&1; then
    # 兜底: 直接插 iptables 规则(重启后失效, 适合一次性环境)
    iptables -C INPUT -p tcp --dport "${SITE_PORT}" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT -p tcp --dport "${SITE_PORT}" -j ACCEPT
    ok "iptables 已放行 ${SITE_PORT}/tcp (重启后失效)"

  else
    warn "未识别到任何防火墙工具, 请手动确认 ${SITE_PORT}/tcp 可达"
  fi
}

# 取得本机所有非 loopback 的 IPv4 地址, 拼接成 LAN 访问 URL
get_lan_urls() {
  local urls=()
  # hostname -I 在大多数发行版可用
  if command -v hostname >/dev/null 2>&1; then
    local ips
    ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.')
    for ip in $ips; do urls+=("http://${ip}:${SITE_PORT}"); done
  fi
  # 兜底: ip addr
  if [[ ${#urls[@]} -eq 0 ]] && command -v ip >/dev/null 2>&1; then
    local ip
    ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
    [[ -n "$ip" ]] && urls+=("http://${ip}:${SITE_PORT}")
  fi
  printf '%s\n' "${urls[@]}"
}

sync_files() {
  info "同步站点文件到 ${SITE_DIR}"
  mkdir -p "${SITE_DIR}"
  rsync -a --delete \
        --include='*/' \
        --include='*.html' --include='*.htm' \
        --include='*.js'  --include='*.mjs' \
        --include='*.css' --include='*.json' \
        --include='*.svg' --include='*.png' --include='*.jpg' \
        --include='*.jpeg'--include='*.gif' --include='*.webp' \
        --include='*.ico' --include='*.woff' --include='*.woff2' \
        --include='*.ttf' --include='*.otf' --include='*.map' \
        --exclude='*' \
        "${SRC_DIR}/" "${SITE_DIR}/"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${SITE_DIR}"
  ok "文件同步完成"
}

# ---------- 核心修复点 ----------
# 1) 只有当端口=80 时才声明 default_server, 避免和 sites-enabled/default 冲突
# 2) Ubuntu 默认 /etc/nginx/sites-enabled/default 会在 80 占 default_server,
#    当 SITE_PORT=80 时,先禁用它再继续
remove_default_site_conflict() {
  local default_site="/etc/nginx/sites-enabled/default"
  if [[ -e "${default_site}" ]] && (( SITE_PORT == 80 )); then
    warn "检测到 ${default_site} 已占用 80 端口的 default_server, 将临时移走"
    mv "${default_site}" "${default_site}.disabled-by-${SITE_NAME}"
  fi
}

write_nginx_conf() {
  info "写入 Nginx 配置: ${NGINX_CONF}"

  # 仅 80 端口加 default_server 关键字; 其他端口不需要
  local LISTEN_LINE="listen ${SITE_PORT};"
  local LISTEN_V6_LINE="listen [::]:${SITE_PORT};"
  if (( SITE_PORT == 80 )); then
    LISTEN_LINE="${LISTEN_LINE} default_server"
    LISTEN_V6_LINE="${LISTEN_V6_LINE} default_server"
  fi

  cat > "${NGINX_CONF}" <<EOF
server {
    ${LISTEN_LINE}
    ${LISTEN_V6_LINE}
    server_name  ${SITE_NAME} _;

    root   ${SITE_DIR};
    index  index.html index.htm;

    # 静态资源缓存
    location ~* \.(?:js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)\$ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
        try_files \$uri =404;
    }

    # SPA / History 路由回退
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # 禁止访问隐藏文件
    location ~ /\.(?!well-known) {
        deny all;
    }

    # gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
EOF
  ok "Nginx 配置已写入"
}

enable_and_reload() {
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx || systemctl restart nginx
  else
    service nginx reload || service nginx restart
  fi
  ok "Nginx 已重新加载"
}

show_status() {
  local state
  state=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${SITE_PORT}" || echo "DOWN")
  info "本地访问 http://127.0.0.1:${SITE_PORT}  -> HTTP ${state}"

  # 列出 LAN 访问入口
  local urls
  urls=$(get_lan_urls)
  if [[ -n "$urls" ]]; then
    info "局域网访问入口:"
    while IFS= read -r u; do printf "         %s\n" "$u"; done <<< "$urls"
  else
    warn "未发现局域网 IP, 请检查网卡或使用 hostname -I 查看"
  fi

  # 防火墙状态自检
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "${SITE_PORT}"; then
    ok "防火墙 ufw: ${SITE_PORT}/tcp 已放行"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --list-ports 2>/dev/null | tr ' ' '\n' | grep -q "^${SITE_PORT}/tcp$"; then
      ok "防火墙 firewalld: ${SITE_PORT}/tcp 已放行"
    else
      warn "防火墙 firewalld: ${SITE_PORT}/tcp 未放行, 局域网可能不通"
    fi
  fi

  # 监听端口自检
  if command -v ss >/dev/null 2>&1; then
    local listen
    listen=$(ss -lnt 2>/dev/null | awk '{print $4}' | grep -E "[:.]${SITE_PORT}$" || true)
    if [[ -n "$listen" ]]; then
      ok "Nginx 正在监听: $(echo $listen | tr '\n' ' ')"
    else
      err "Nginx 未在监听 ${SITE_PORT}, 请检查 nginx -t 和日志"
    fi
  fi

  ls -lh "${SITE_DIR}" 2>/dev/null | head -n 20 || true
}

do_install() {
  [[ $EUID -ne 0 ]] && { err "请使用 root 运行: sudo $0 ${ACTION}"; exit 1; }
  PKG_MGR=$(detect_pkg_mgr)
  command -v nginx >/dev/null 2>&1 || install_nginx
  remove_default_site_conflict
  sync_files
  write_nginx_conf
  open_firewall
  enable_and_reload
  show_status
  ok "部署完成"
}

do_restart() {
  [[ $EUID -ne 0 ]] && { err "请使用 root 运行: sudo $0 ${ACTION}"; exit 1; }
  sync_files
  enable_and_reload
  open_firewall
  show_status
  ok "已重启"
}

do_status() {
  show_status
  if command -v systemctl >/dev/null 2>&1; then
    systemctl status nginx --no-pager 2>/dev/null || true
  fi
}

do_uninstall() {
  [[ $EUID -ne 0 ]] && { err "请使用 root 运行: sudo $0 ${ACTION}"; exit 1; }
  rm -f "${NGINX_CONF}"
  rm -rf "${SITE_DIR}"

  # 清理防火墙规则
  if command -v ufw >/dev/null 2>&1; then
    ufw delete allow "${SITE_PORT}/tcp" 2>/dev/null || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --remove-port="${SITE_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi

  nginx -t 2>/dev/null && (systemctl reload nginx 2>/dev/null || true) || true
  local default_site="/etc/nginx/sites-enabled/default.disabled-by-${SITE_NAME}"
  if [[ -e "${default_site}" ]]; then
    mv "${default_site}" "/etc/nginx/sites-enabled/default"
    warn "已还原 ${default_site}"
  fi
  ok "已卸载 ${SITE_NAME}"
}

case "${ACTION}" in
  install)   do_install ;;
  restart)   do_restart ;;
  status)    do_status  ;;
  uninstall) do_uninstall ;;
  *) echo "Usage: $0 {install|restart|status|uninstall} [PORT=NNNN]"; exit 1 ;;
esac
