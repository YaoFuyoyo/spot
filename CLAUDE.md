# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

产业链平台（npm 包名 `spot-web`）：纯 HTML + 原生 JS 工具台，Node 22 内置 `http` 同时提供静态文件和 `/api/*`。无 npm 运行时依赖。四个工具：

| 工具 | 页面 | 后端 |
|---|---|---|
| 产业穿透 | `tool-spot/spot.html` | 无（浏览器内解析 Excel → 3D 图） |
| 产业链图谱演示 | `tool-chainmap/chainmap.html` | 无（浏览器内解析 Excel → 卡片） |
| 新增产业链 | `tool-addchain/addchain.html` | `POST /api/addchain` |
| 产品上下游关系网 | `tool-updown/updown.html` | `POST /api/updown`（spawn Python 生成器，需 python3 + openpyxl） |
| 产品补充 | `tool-addprod/addprod.html` | `/api/addprod*` + SQLite 知识库 |

首页 `index.html` 只做工具卡片导航。

## 常用命令

需要 **Node ≥ 22**（`node:sqlite`、`process.loadEnvFile`）。仓库无 `npm test` / lint / 构建脚本。

```bash
# 本地（端口：命令行参数 > PORT > 9999）
cp .env.example .env          # 填 LLM_API_KEY；.env 已被 gitignore
node server.js                # 或 npm start
node server.js 8085
bash dev_start.sh             # nvm 切 Node 22 后前台启动
bash dev_start.sh bg 8085     # 后台 + 健康检查
bash dev_start.sh stop|status|logs|restart

# 从 Excel 全量重建 SQLite（可重复执行，会清空 product/meta）
node tool-addprod/api/seed_db.js
node tool-addprod/api/seed_db.js --db /path/to/addprod.sqlite

# 健康检查（应返回 {"ok":true,...}）
curl 'http://127.0.0.1:9999/api/addprod/kb?page=1&size=1'

# Docker：Compose 与 docker_deploy.sh 二选一，不要混用（容器名/数据卷/环境变量会打架）
docker compose up -d --build
bash docker_deploy.sh up 9999
bash docker_deploy.sh restart|status|logs|shell|down|clean
```

`python3 serve.py 8080` 和 `deploy_html_js.sh` 只提供静态文件，**没有 API**。本地联调 addchain/addprod 必须用 `server.js`。

产品分类 skill 的 Python 旁路（读 Excel，不碰运行时 SQLite）：

```bash
python skills/product-taxonomy-supplement/scripts/query_kb.py info
python skills/product-taxonomy-supplement/scripts/query_kb.py check 盾构机
# 依赖 openpyxl；落表用 apply_kb.py，中文写入优先 --spec spec.json
```

## 架构

```
浏览器 HTML
  ├─ tool-spot / tool-chainmap     纯前端，vendor 里的 xlsx / three / 3d-force-graph / html2canvas
  └─ tool-addchain / tool-addprod  fetch('/api/...')
        │
server.js（或 Vercel 按 vercel.json 把同一 handler 打成 serverless）
  ├─ POST /api/addchain            tool-addchain/api/addchain.js
  ├─ POST /api/updown              tool-updown/api/updown.js（Node 建词表/对齐 KB 码，
  │                                spawn skills/product-updown-excel/scripts/generate_updown.py
  │                                产出 12 列上下游关系 Excel；本地需 python3 + openpyxl）
  ├─ POST /api/addprod             tool-addprod/api/addprod.js
  ├─ POST /api/addprod/archive     tool-addprod/api/archive.js
  ├─ GET  /api/addprod/kb          tool-addprod/api/kb.js
  └─ GET  /api/addprod/export      tool-addprod/api/export.js
        │
        ├─ LLM  OpenAI-compatible：LLM_BASE + /v1/chat/completions（默认 http://10.2.13.11:3000，模型 gpt-5.6-luna）
        └─ SQLite  data/addprod.sqlite（可用 ADDPROD_DB_PATH 覆盖）
```

- API 统一信封：`{ ok: true|false, error? }`。JSON 失败时前端只展示 `error`。
- `server.js` 禁止路径段以 `.` 开头（防 `.env`）；`/app`、`/app/`、`/app/*` 是部署平台 URL 前缀，映射到仓库根，不是磁盘目录。
- Handler 同时给本地 `require()` 和 Vercel `@vercel/node` 用，改路由时两边都要改（`server.js` + `vercel.json`）。
- Vercel 上 SQLite 文件系统是临时的，产品知识库持久化以 Docker/宿主机 `data/` 为准。

### Skills 是 LLM 工具的规格书

改 addchain / addprod 之前先读对应 `SKILL.md`，提示词和落表规则必须跟 skill 走，不要在 handler 里另起一套：

- `skills/industry-chain-graph/` — 参考码值 Excel + `模板-空表.xlsx`；`addchain.js` 读 references、调 LLM、按 Step 3–5 填 概况/图谱（预留空的 上链策略/挂链策略）。
- `skills/product-updown-excel/` — 12 列上下游关系表；`updown.js` 读其 references 的《产品分类知识库》，LLM 只给产品名、Node 对齐 KB 码后经 `--edges` 注入（禁止 LLM 编编码），spawn `generate_updown.py` 落表（产业图谱来源由脚本内置采集）。
- `skills/product-taxonomy-supplement/` — 分类规则与 Excel 源；运行时以 SQLite 为准，Excel 只作 `seed_db.js` 迁移源和 `export.js` 表头模板。`scripts/query_kb.py` / `apply_kb.py` 是原始 Excel 工作流，与 `kb_data.js` 并行存在。

### 产品分类知识库

4 级 × 每级 2 位数字 = 8 位编码；1 级前两位 = 国标行业大类（C35 ↔ `35`）。每级最多 99 个。

- 表 `product` = Excel【结构化】sheet：`code / name / level / industry / synonyms`。
- 【层级】sheet **不存库**，按归属链实时 JOIN 推导，避免双 sheet 漂移。
- 【结构化】同义词列只放同义词、不含主名、不含冒号，多个用中文分号 `；`。【层级】名称列写成 `主名：同义词1；同义词2`。
- 统一替换词（机械/机器/设备…）在匹配时等价，**不要**再录入为同义词。规则在 `kb_data.js` 的 `REPLACE_GROUPS` 与 `references/维护规则.md`。
- 行业统称/上位词 → `action=synonym`，禁止新增节点（典型：工程机械 → `3503 建筑工程机械`）。

`POST /api/addprod` 流程：

1. `KB.precheck`：精确名 / 已是同义词 / 替换词命中 → `action=exists`，不调 LLM。
2. 否则把候选归属链、子级、`nextCode` 塞进 prompt，LLM 只输出 JSON：`synonym | add | uncertain`。
3. **编号由 `KB.nextCode` 本地分配**。LLM 只给 `parent_code`（或本批次 `NEW`），禁止编造编码。校验失败会带错误反馈重试一次。
4. 前端用返回的 `spec` 调 `POST /api/addprod/archive`：先 `dryRun`，通过再写入；预检与写入之间被抢写则 409。

新增非 4 级时必须补齐到 4 级链路（3 级 ≥2 行，2 级 ≥3 行，1 级 ≥4 行），下级名称必须是真实产品词。

### SQLite / Docker 坑

近期大量提交都在修 `disk I/O error` 和导出失败，改存储层时不要回退这些约束：

- `journal_mode=DELETE`（不用 WAL，避免 `-wal/-shm` 在 bind mount 上失败）。
- `synchronous=NORMAL`，`busy_timeout=10000`。
- 数据库不要放在 WSL `/mnt/*`、Windows 共享盘、或 `/ftp/docker/volumes` 子路径。
- CentOS 7（kernel 3.10）上必须加 `--security-opt seccomp=unconfined`（见 `docker_deploy.sh` / `docker-compose.yml`）。默认 seccomp 会把 `node:sqlite` 写盘变成 `SQLITE_IOERR_WRITE` (778)，`:memory:` 正常、文件库 `disk I/O error`。新内核可再收紧 profile。
- 当前部署默认 **bind mount 宿主机目录**：`DATA_DIR` 默认 `/ftp/spot/data` → 容器 `/app/data`（见 `docker-compose.yml`、`docker_deploy.sh`）。不要把 `DATA_DIR` 指到 Windows 共享。
- `ADDPROD_BACKUP` 默认关闭；`=1` 时存档前 `VACUUM INTO` 生成 `.bak.sqlite`。
- `export.js` 遇瞬时 I/O/锁会重试；仍失败则回退内置 Excel 模板，并设 `fallback: true`（不含未同步的运行期变更）。
- 空库时 `kb_data.js` 会建表，但没有产品数据。要用完整知识库：把已有 `data/addprod.sqlite` 放到数据目录，或跑 `seed_db.js`。
- 镜像必须复制根目录 `index.html`，否则 `/index.html` 会 404。

## 前端约定

每个工具一个 HTML，CSS/JS 内联，通过 `../common/vendor/` 引库。不要引入 React/构建链/npm 前端依赖。

- addchain / addprod 的 Excel 下载：接口返回 `{ file: { name, base64 } }` 或 `{ filename, base64 }`，前端 `atob` 后存盘。
- 产业穿透输入 workbook 的 sheet 名必须是：`产品原料关系表`、`企业主营产品表`、`专利权所属表`、`供销方关系表`、`股权投资关系表`（见 `tool-spot/spot.html` 的 `TABLE_NAMES`）。模板：`tool-spot/示例模板.xlsx`。
- 图谱演示输入：第一张 sheet，列是 一级/企业量/二级/企业量/三级/企业量/四级/企业量，合并单元格 forward-fill。示例：`tool-chainmap/人形机器人.xlsx`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `LLM_API_KEY` | 必填；未配置时接口明确报错，**禁止硬编码密钥** |
| `LLM_BASE` | 默认 `http://10.2.13.11:3000` |
| `LLM_MODEL` | 默认 `gpt-5.6-luna` |
| `LLM_TIMEOUT_MS` | 默认 `180000` |
| `PORT` / `HOST` | 默认 `9999` / `0.0.0.0` |
| `ADDPROD_DB_PATH` | SQLite 路径，默认 `data/addprod.sqlite` |
| `ADDPROD_BACKUP` | `1` 开启存档前整库备份 |
| `AMARDATA_MCP_URL` | 产品上下游关系网事实来源 MCP 端点（含 apiKey）；未配置时税票商品/上市信息/舆情资讯为 0 条 |
| `AMARDATA_TIMEOUT_MS` | MCP 单次请求超时，默认 60000 |
| `UPDOWN_PYTHON` | updown 生成器 Python 解释器，默认 `python` |

`_io/` 可被 addprod 写入最近一次 LLM JSON，已 gitignore。`data/*.sqlite` 是运行时数据，不入库。
