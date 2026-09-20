#!/usr/bin/env bash
# =============================================================
#  Docker 一键部署脚本 (镜像 < 80MB)
#  特性: 构建/启动/健康检查/日志/停止一条龙
#
#  用法:
#     bash docker_deploy.sh build          # 构建镜像
#     LLM_API_KEY=你的密钥 bash docker_deploy.sh up 8085
#     LLM_API_KEY=你的密钥 bash docker_deploy.sh restart 8085
#     bash docker_deploy.sh restart 8085 你的密钥
#     LLM_API_KEY=你的密钥 LLM_BASE=http://大模型地址:端口 bash docker_deploy.sh up 8085
#     bash docker_deploy.sh down           # 停止
#     bash docker_deploy.sh status         # 健康检查
#     bash docker_deploy.sh logs           # 实时日志
#     bash docker_deploy.sh restart 8085   # 重启
#     bash docker_deploy.sh shell          # 进容器
#     bash docker_deploy.sh clean          # 删镜像
#     bash docker_deploy.sh mirror         # 配置国内镜像源 (国内网络必跑)
# =============================================================
set -euo pipefail

# ---------- 配置 ----------
IMAGE_NAME="${IMAGE_NAME:-spot-web}"
CONTAINER_NAME="${CONTAINER_NAME:-spot-web}"
DEFAULT_PORT="${DEFAULT_PORT:-9999}"
PORT="${2:-$DEFAULT_PORT}"
HOST_PORT="${PORT}"

# LLM 配置只在容器运行时注入，不写入镜像层
LLM_BASE="${LLM_BASE:-http://10.2.13.11:3000}"
LLM_MODEL="${LLM_MODEL:-gpt-5.6-luna}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-180000}"
# ---------------------

cd "$(dirname "$0")"
# 默认绑定宿主机业务目录，避开 /ftp/docker/volumes 子路径对 SQLite 真实写入的限制。
# /ftp/spot 是常见部署路径；其他环境显式传 DATA_DIR 即可。
DATA_DIR="${DATA_DIR:-/ftp/spot/data}"
DATA_VOLUME="${DATA_VOLUME:-}"

# 可选: 从项目根目录 .env 读取 LLM 配置
# 格式: LLM_API_KEY=xxx，不要写 export，也不要加空格
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  LLM_BASE="${LLM_BASE:-http://10.2.13.11:3000}"
  LLM_MODEL="${LLM_MODEL:-gpt-5.6-luna}"
  LLM_API_KEY="${LLM_API_KEY:-}"
  LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-180000}"
fi

# 可选第三参数: restart/up 8085 YOUR_KEY
# 更推荐使用 .env，避免密钥出现在 shell 历史记录
if [[ -n "${3:-}" ]]; then
  LLM_API_KEY="$3"
fi

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[INFO] $*"; }
ok()    { color "32" "[ OK ] $*"; }
err()   { color "31" "[FAIL] $*"; }
warn()  { color "33" "[WARN] $*"; }

# 检查 docker
if ! command -v docker >/dev/null 2>&1; then
  err "未安装 docker, 请先: https://docs.docker.com/engine/install/"
  exit 1
fi

check_port() {
  # 端口已被占用且不是我们自己容器在用 → 报错
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -E "[:.]$HOST_PORT\$" >/dev/null; then
      # 看看是不是容器占的
      if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}\$"; then
        err "宿主机端口 $HOST_PORT 已被占用"
        exit 1
      fi
    fi
  fi
}

# ---------- build ----------
do_build() {
  info "构建镜像 (多阶段, 目标 < 80MB)"

  # 如果没有 package.json 就给个最小的 (xlsx 等运行时依赖)
  if [[ ! -f package.json ]]; then
    warn "无 package.json, 自动生成最小配置"
    cat > package.json <<EOF
{
  "name": "spot-web",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=22" },
  "dependencies": {}
}
EOF
  fi

  docker build -t "${IMAGE_NAME}:latest" -t "${IMAGE_NAME}:$(date +%Y%m%d-%H%M%S)" .
  ok "镜像构建完成"
  docker images "${IMAGE_NAME}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
}

# ---------- up ----------
do_up() {
  check_port
  # 停掉旧的
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

  # SQLite 在 /ftp/docker/volumes 子路径上会报 disk I/O error，
  # 默认 bind 宿主机的业务目录（推荐 /ftp/spot/data），跳过 named volume。
  local data_mount
  if [[ -n "${DATA_VOLUME}" ]]; then
    docker volume create "${DATA_VOLUME}" >/dev/null
    data_mount="${DATA_VOLUME}:/app/data"
    warn "显式指定 DATA_VOLUME=${DATA_VOLUME}，将使用 Docker 数据卷（已知 XFS 子路径对 SQLite 不可靠）"
  else
    mkdir -p "${DATA_DIR}"
    data_mount="${DATA_DIR}:/app/data"
    info "绑定宿主机目录: ${DATA_DIR} -> /app/data"
  fi

  info "启动容器: -p ${HOST_PORT}:${PORT} (容器内 ${PORT})"
  # CentOS 7 (kernel 3.10) + Docker 默认 seccomp 会拦截 node:sqlite 写盘 syscall，
  # 表现为 SQLITE_IOERR_WRITE (778 / disk I/O error)。unconfined 后文件库可写。
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --security-opt seccomp=unconfined \
    -p "${HOST_PORT}:${PORT}" \
    -v "${data_mount}" \
    -e PORT="${PORT}" \
    -e HOST=0.0.0.0 \
    -e ADDPROD_BACKUP=0 \
    -e LLM_BASE="${LLM_BASE}" \
    -e LLM_MODEL="${LLM_MODEL}" \
    -e LLM_API_KEY="${LLM_API_KEY}" \
    -e LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS}" \
    "${IMAGE_NAME}:latest"

  # 等几秒, 看是否真起来了
  sleep 3
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}\$"; then
    ok "容器已启动, 镜像体积:"
    docker images "${IMAGE_NAME}" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | head -n 2
    show_banner
  else
    err "容器未启动, 看日志:"
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -n 30
    exit 1
  fi
}

show_banner() {
  info "访问入口:"
  printf "         本机:   http://127.0.0.1:%s/tool-addprod/addprod.html\n" "${HOST_PORT}"
  for ip in $(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.'); do
    printf "         局域网: http://%s:%s/tool-addprod/addprod.html\n" "$ip" "${HOST_PORT}"
  done
}

# ---------- down ----------
do_down() {
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}\$"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null
    ok "容器已停止并删除"
  else
    ok "容器未运行"
  fi
}

# ---------- status ----------
do_status() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}\$"; then
    err "容器未运行"
    return 1
  fi

  info "容器状态:"
  docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | head -n 3

  # 健康检查: 真的打一次 API
  local resp
  resp=$(curl -s --max-time 5 "http://127.0.0.1:${HOST_PORT}/api/addprod/kb?page=1&size=1" || echo "")
  if echo "$resp" | head -c 1 | grep -q '{'; then
    ok "API 返回 JSON ✓"
  else
    err "API 异常: $(echo "$resp" | head -c 100)"
  fi

  show_banner
}

# ---------- logs ----------
do_logs() {
  docker logs -f --tail=100 "${CONTAINER_NAME}"
}

# ---------- restart ----------
do_restart() {
  do_down
  do_up
}

# ---------- shell ----------
do_shell() {
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}\$"; then
    docker exec -it "${CONTAINER_NAME}" sh
  else
    err "容器未运行"
  fi
}

# ---------- clean ----------
do_clean() {
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  docker rmi "${IMAGE_NAME}:latest" 2>/dev/null || true
  ok "已清理"
}

# ---------- 国内镜像源配置 ----------
# 网络问题(short read / EOF)基本都是 docker hub 拉取失败, 配 mirror 解决
do_mirror() {
  [[ $EUID -ne 0 ]] && { err "请用 sudo: sudo $0 mirror"; exit 1; }

  # 自动检测可用的镜像加速器 (按速度测试, 失败的回退)
  local mirrors=(
    "https://docker.mirrors.ustc.edu.cn"
    "https://hub-mirror.c.163.com"
    "https://mirror.baidubce.com"
    "https://dockerproxy.com"
    "https://docker.m.daocloud.io"
  )

  # 检测 daemon 类型
  local cfg=""
  if [[ -f /etc/docker/daemon.json ]]; then
    cfg="/etc/docker/daemon.json"
  else
    cfg="/etc/docker/daemon.json"
    mkdir -p /etc/docker
  fi

  # 合并现有配置 (不要覆盖用户的其它设置)
  local current
  current=$(cat "$cfg" 2>/dev/null || echo "{}")
  local merged
  merged=$(node -e "
    const cur = $current;
    const mirrors = $(printf '%s\n' "${mirrors[@]}" | node -e 'process.stdin.on("data",d=>{const a=d.toString().trim().split(/\n/).filter(Boolean);process.stdout.write(JSON.stringify(a));})');
    cur['registry-mirrors'] = Array.from(new Set([...(cur['registry-mirrors']||[]), ...mirrors]));
    process.stdout.write(JSON.stringify(cur, null, 2));
  " 2>/dev/null || echo "")

  if [[ -z "$merged" ]]; then
    # 兜底: 直接写, 不解析现有 json
    cat > "$cfg" <<EOF
{
  "registry-mirrors": [
$(printf '    "%s",\n' "${mirrors[@]}" | sed '$ s/,$//')
  ]
}
EOF
  else
    echo "$merged" > "$cfg"
  fi

  ok "已写入镜像源到 $cfg"
  cat "$cfg"
  echo

  # 重启 docker daemon
  info "重启 docker daemon..."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart docker
  elif command -v service >/dev/null 2>&1; then
    service docker restart
  else
    warn "请手动重启 docker"
  fi

  sleep 2
  docker info 2>/dev/null | grep -A 5 "Registry Mirrors" || warn "未检测到 Registry Mirrors, 请检查配置"
  ok "完成. 现在跑: sudo $0 up 8085"
}

# ---------- main ----------
case "${1:-}" in
  build)    do_build ;;
  up)       do_build; do_up ;;
  down)     do_down ;;
  status)   do_status ;;
  logs)     do_logs ;;
  restart)  do_restart ;;
  shell)    do_shell ;;
  clean)    do_clean ;;
  mirror)   do_mirror ;;
  *)
    cat <<EOF
Usage: $0 {build|up|down|status|logs|restart|shell|clean|mirror} [PORT]

Examples:
  $0 mirror                   # 配置国内镜像源 (网络问题先跑)
  $0 build                    # 只构建镜像
  $0 up 8085                  # 构建+后台启动, 端口 8085
  $0 status 8085              # 检查 8085
  $0 restart 8085             # 重启
  $0 logs                     # 实时日志
  $0 down                     # 停止
  $0 clean                    # 删除镜像

环境变量:
  IMAGE_NAME=xxx    自定义镜像名 (默认 spot-web)
  CONTAINER_NAME=xx 自定义容器名 (默认 spot-web)
EOF
    exit 1
    ;;
esac
