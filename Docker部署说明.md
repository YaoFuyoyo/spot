---
标题: SPOT HTML+JavaScript Docker 部署说明
分类: 项目
标签: [Docker, HTML, JavaScript, Node.js, SQLite, 部署]
来源: 项目部署脚本与当前部署实践
更新时间: 2026-04-10
---

# SPOT HTML+JavaScript Docker 部署说明

## 架构概览

项目采用轻量 Web 架构：

- **前端**：根目录 `index.html` 与各工具目录下的 HTML 页面；页面内嵌 CSS、原生 JavaScript，通过 `fetch` 调用 API。
- **后端**：`server.js` 使用 Node.js 内置 `http` 模块提供静态文件与 API 路由。
- **接口实现**：位于 `tool-addprod/api/`、`tool-addchain/api/`，由 `server.js` 按 `/api/...` 路由转发。
- **数据存储**：产品知识库使用 SQLite，默认文件为 `/app/data/addprod.sqlite`。
- **容器化**：`Dockerfile` 基于 Node 22 Alpine 构建；镜像启动后监听 `9999` 端口。
- **持久化**：Docker named volume `spot-data` 挂载到 `/app/data`，避免将 SQLite 直接放到 Windows/WSL 共享目录导致 `disk I/O error`。

> 容器镜像需显式复制根目录 `index.html`，否则访问 `/index.html` 会返回 `Not Found: /app/index.html`。

## 页面与服务入口

- 首页：`http://<服务器IP>:9999/index.html`
- 产品补充：`http://<服务器IP>:9999/tool-addprod/addprod.html`
- 产品知识库 API 健康检查：`http://<服务器IP>:9999/api/addprod/kb?page=1&size=1`

服务端兼容 `/app`、`/app/` 与 `/app/index.html` 形式的平台入口，并映射到根目录首页。

## 前置条件

1. 已安装 Docker 与 Docker Compose。
2. 在项目根目录执行命令（包含 `Dockerfile`、`docker-compose.yml`、`docker_deploy.sh`）。
3. 如需调用大模型，在 `.env` 或环境变量中设置 `LLM_API_KEY`；不要将密钥提交到 Git。

`.env` 示例：

```dotenv
LLM_API_KEY=your-secret-key
LLM_BASE=http://10.2.13.11:3000
LLM_MODEL=gpt-5.6-luna
LLM_TIMEOUT_MS=180000
```

## 标准部署（Docker Compose）

代码、Dockerfile 或前端页面变更后，重新构建并后台启动：

```bash
docker compose up -d --build
```

检查容器状态和接口：

```bash
docker compose ps
curl 'http://127.0.0.1:9999/api/addprod/kb?page=1&size=1'
```

查看日志：

```bash
docker compose logs -f --tail=100
```

停止服务：

```bash
docker compose down
```

## 使用一键部署脚本

脚本 `docker_deploy.sh` 使用镜像 `spot-web:latest`、容器名 `spot-web`，默认使用 `spot-data` Docker 数据卷。

### 首次部署或需要重新构建

```bash
bash docker_deploy.sh up 9999
```

该命令会构建镜像后启动容器。

### 仅重启已构建的镜像

```bash
bash docker_deploy.sh restart 9999
```

`restart` **不会重新构建镜像**。若改动了 `Dockerfile`、`server.js`、HTML、API 等内容，必须先构建，再重启：

```bash
# 重建 Docker 镜像
docker compose up -d --build

# 按现有运维方式重启 9999 服务
bash docker_deploy.sh restart 9999
```

以上两条命令可执行，但通常应二选一：

- 采用 Compose 管理时，使用 `docker compose up -d --build` 即可；
- 采用部署脚本管理时，使用 `bash docker_deploy.sh up 9999` 即可。

避免在两种管理方式间混用不同的环境变量、数据卷名称或容器名称。

## 常用运维命令

```bash
# 查看运行状态和 API 检查
bash docker_deploy.sh status 9999

# 查看实时日志
bash docker_deploy.sh logs

# 进入容器排查
bash docker_deploy.sh shell

# 停止并删除容器（保留 named volume 数据）
bash docker_deploy.sh down

# 删除容器和 latest 镜像（不会自动删除 named volume）
bash docker_deploy.sh clean
```

## SQLite 与下载故障排查

### `disk I/O error`

常见原因是 SQLite 数据库位于 WSL `/mnt/*`、Windows 共享目录或不兼容的文件系统。默认部署应保留 named volume：

```bash
docker volume inspect spot-data
```

不要将 `DATA_DIR` 指到 Windows 共享挂载目录；如必须使用宿主机路径，请使用 Linux 本地磁盘路径，例如 `/var/lib/spot/data`：

```bash
DATA_DIR=/var/lib/spot/data bash docker_deploy.sh up 9999
```

下载接口对瞬时 SQLite I/O 或锁冲突会重试；若实时库无法读取，会回退下载内置知识库模板，并在页面提示该模板不包含尚未同步的运行期变更。

### 首页报 `Not Found: /app/index.html`

确认使用了含如下 Dockerfile 配置的新镜像：

```dockerfile
COPY --chown=app:app index.html ./index.html
```

然后重新构建部署：

```bash
docker compose up -d --build
```

## 部署验收清单

```bash
# 1. 容器应为 Up / healthy
docker ps --filter name=spot-web

# 2. 首页应返回 HTTP 200
curl -I http://127.0.0.1:9999/index.html

# 3. API 应返回 {"ok":true,...}
curl 'http://127.0.0.1:9999/api/addprod/kb?page=1&size=1'

# 4. 浏览器打开页面并测试知识库下载
# http://<服务器IP>:9999/tool-addprod/addprod.html
```
