# 纯 HTML + JS 项目在 Linux 上的部署

## 1. 部署的本质

纯前端项目没有运行时, 任何能把静态文件对外提供 HTTP 服务的程序都可以:

| 方案 | 适用场景 | 性能 | 上手难度 |
|------|----------|------|----------|
| **Nginx** | 生产环境, 公网部署 | ★★★★★ | 中 |
| **Caddy** | 想要自动 HTTPS | ★★★★★ | 低 |
| **Apache httpd** | 已有 Apache 栈 | ★★★★ | 中 |
| **Node.js (http-server / serve)** | 临时演示, 容器化 | ★★ | 最低 |
| **Python http.server** | 本地/内网快速预览 | ★ | 最低 |
| **对象存储 + CDN** (OSS/S3+CloudFront) | 纯静态、面向用户 | ★★★★★ | 中 |

> 单页应用 (SPA) 还需注意: 后端路由回退 (try_files / fallback), 直接刷新页面不能 404。

---

## 2. 推荐的部署目录结构

```
/var/www/my-static-site/        # 站点根目录
├── index.html
├── assets/
│   ├── app.js
│   ├── style.css
│   └── img/
└── favicon.ico

/etc/nginx/conf.d/my-static-site.conf   # Nginx server 块
/var/log/nginx/                          # 访问/错误日志
```

部署脚本默认假设: 把当前目录下的 `*.html / *.js / *.css / 静态资源` 同步到 `/var/www/<site>`。

---

## 3. 部署步骤 (Nginx)

### 3.1 上传代码
```bash
rsync -avz --delete ./dist/  user@server:/var/www/my-static-site/
```
或者用 `scp`、`git pull` + `deploy_html_js.sh restart`。

### 3.2 一键脚本
把 `deploy_html_js.sh` 放到任意目录, 然后:

```bash
chmod +x deploy_html_js.sh
sudo ./deploy_html_js.sh install   # 安装 nginx 并部署
sudo ./deploy_html_js.sh restart   # 代码更新后增量同步
sudo ./deploy_html_js.sh status    # 查看运行状态
sudo ./deploy_html_js.sh uninstall # 卸载
```

### 3.3 验证
```bash
curl -I http://127.0.0.1
nginx -T | grep my-static-site
```

---

## 4. 启用 HTTPS (可选)

公网部署建议上 HTTPS, 三种方式选其一:

1. **Let's Encrypt + Certbot (免费, 推荐)**
   ```bash
   sudo apt install certbot python3-certbot-nginx -y
   sudo certbot --nginx -d example.com -d www.example.com
   ```
2. **Caddy**: 自动签发 + 自动续期, 配置 4 行即可。
3. **自有证书**: 将 `*.pem` 放到 `/etc/nginx/ssl/`, 在 server 块里加 `ssl_certificate` 指令。

---

## 5. Docker 化部署 (可移植)

```dockerfile
# Dockerfile
FROM nginx:1.27-alpine
COPY ./dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

```bash
docker build -t my-static-site .
docker run -d --name my-site -p 80:80 my-static-site
```

---

## 6. 常见坑

- **刷新页面 404**: SPA 没配 `try_files $uri $uri/ /index.html;`。
- **静态资源 304 不更新**: 浏览器缓存, 给 `*.js / *.css` 加 hash 文件名或版本号。
- **跨域 (CORS)**: 调用别的 API 时, 服务端要加 `Access-Control-Allow-Origin`。
- **目录浏览**: 默认已关, 千万不要打开 `autoindex on;`。
- **权限**: 站点目录归属 `www-data`(Debian) 或 `nginx`(RHEL)。

---

## 7. 本脚本提供的两个文件

- `deploy_html_js.sh` — 生产级 Nginx 部署/卸载脚本 (支持 Ubuntu/CentOS)
- `serve.py` — 0 依赖的 Python 静态服务器 (含 SPA 回退 + gzip)

按场景选择: 演示/调试用 `serve.py`, 正式上线用 `deploy_html_js.sh`。
