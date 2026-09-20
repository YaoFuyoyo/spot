# =============================================================
# Node 22 Alpine 运行镜像
# 业务依赖主要是 Node 内置模块 + 项目内置 vendor 文件
# =============================================================

FROM node:22-alpine AS builder

WORKDIR /build

# 当前项目没有 package-lock.json，因此使用 npm install 而不是 npm ci
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir -p /build/node_modules

FROM node:22-alpine

# node:sqlite 在 Alpine 环境需要 C++ 运行库；su-exec 用于入口阶段
# 产品上下游关系网（tool-updown）需调用 Python 生成器，附带 python3 + openpyxl
# 修正 Docker 数据卷权限后再降权运行服务。
RUN apk add --no-cache libstdc++ su-exec python3 py3-openpyxl

WORKDIR /app

# 非 root 用户运行
RUN addgroup -S app && adduser -S app -G app

# 即使当前无 npm 依赖，也保留目录，避免 COPY 源路径不存在
COPY --from=builder --chown=app:app /build/node_modules ./node_modules

# 服务入口、首页、前端页面、SQLite 数据库、内置 vendor 和模板
# 根目录首页必须显式复制；否则容器内 /app/index.html 不存在。
COPY --chown=app:app server.js ./server.js
COPY --chown=app:app index.html ./index.html
COPY --chown=app:app tool-addprod ./tool-addprod
COPY --chown=app:app tool-addchain ./tool-addchain
COPY --chown=app:app tool-updown ./tool-updown
COPY --chown=app:app tool-chainmap ./tool-chainmap
COPY --chown=app:app tool-spot ./tool-spot
COPY --chown=app:app common ./common
COPY --chown=app:app skills ./skills
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

# 仅准备镜像层 /app/data 占位目录。运行时挂载会覆盖它，
# 因此这里不递归 chown 宿主目录。
RUN mkdir -p /app/data \
    && chmod 755 /usr/local/bin/docker-entrypoint

# 不在此处 USER app：入口脚本须先以 root 修复挂载卷权限，随后使用 su-exec 降权。

ENV NODE_ENV=production \
    PORT=9999 \
    HOST=0.0.0.0 \
    ADDPROD_BACKUP=0 \
    LLM_BASE=http://10.2.13.11:3000 \
    LLM_MODEL=gpt-5.6-luna

EXPOSE 9999

# 通过 API 验证服务真的可用，而不是只检查 Node 进程存在
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/addprod/kb?page=1&size=1" \
        | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["sh", "-c", "exec node server.js \"${PORT}\""]
