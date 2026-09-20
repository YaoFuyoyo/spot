#!/bin/sh
# 入口脚本：解决 bind mount 由 root 创建导致 SQLite 真实落盘失败的问题。
# - /app/data 必须对 app 用户可写；否则 SQLite 报 "disk I/O error"。
# - 数据卷可能在构建之后才挂载，因此每次启动都重新授权。
set -eu

mkdir -p /app/data

# 仅当 bind mount 可见时执行权限修复；不要递归修改宿主机目录属主，
# 以免误改 /ftp/spot 这种系统根目录。先看当前属主能否被 app 访问：
#   1) 属主是 root 且权限 0775 → chmod 添置 g+w，让 app 组可写；
#   2) 属主已经是 app → 直接通过；
#   3) 其他 → 启动失败，给出明确提示。
fix_acl() {
  cur_owner=$(stat -c '%u:%g' /app/data 2>/dev/null || echo "0:0")
  cur_mode=$(stat -c '%a' /app/data 2>/dev/null || echo "0")
  case "$cur_owner" in
    root:root|0:0)
      chmod 0775 /app/data
      ;;
    app:app|"$(id -u app):$(id -g app)")
      ;;
    *)
      if id "app" 2>/dev/null >/dev/null && getent group "$(id -g app)" >/dev/null 2>&1; then
        if [ "$(stat -c '%g' /app/data)" = "$(id -g app)" ]; then
          chmod 0775 /app/data
        else
          echo "[spot] ERROR: /app/data owner $(stat -c '%U:%G' /app/data) not app:app; chmod 0775 insufficient." >&2
          echo "[spot] 建议: chown -R $(id -u app):$(id -g app) $(stat -c '%m' /app/data)  # 仅针对数据目录" >&2
          exit 1
        fi
      fi
      ;;
  esac

  if [ ! -w /app/data ]; then
    echo "[spot] ERROR: /app/data is not writable by $(id -un):$(id -gn); chmod 0775 insufficient." >&2
    exit 1
  fi
}

if [ "$(id -u)" = "0" ]; then
  fix_acl
  exec su-exec app "$@"
fi

# 非 root 启动：直接校验可写性，避免被 SQLite 报难以定位的 disk I/O error。
if [ ! -w /app/data ]; then
  echo "[spot] ERROR: /app/data is not writable by $(id -u):$(id -g); check host ./data ownership" >&2
  exit 1
fi

exec "$@"
