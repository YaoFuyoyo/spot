# =============================================================
#  极简部署: 不安装 Nginx, 用 Python 内置服务器
#  适合本地/内网快速预览或临时演示
#  用法:  sudo python3 serve.py 8080
# =============================================================
#!/usr/bin/env python3
"""Minimal static file server with SPA fallback and gzip."""
import sys, os, gzip, io, mimetypes, http.server, socketserver
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = Path(__file__).resolve().parent
INDEX_FALLBACK = "index.html"
GZIP_TYPES = {"text/html", "text/css", "application/javascript",
              "application/json", "image/svg+xml"}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def translate_path(self, path):
        full = super().translate_path(path)
        # SPA / History 模式: 找不到文件时回退到 index.html
        if not os.path.exists(full) and not path.startswith(("/api", "/static")):
            return super().translate_path("/" + INDEX_FALLBACK)
        return full

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        super().do_GET()
        # 简易 gzip: 仅当客户端接受且类型匹配时压缩
        ctype = mimetypes.guess_type(self.path)[0] or ""
        if "gzip" in self.headers.get("Accept-Encoding", "") and ctype in GZIP_TYPES:
            try:
                body = self.wfile.getvalue()
                buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                    gz.write(body)
                self.wfile = buf.getvalue()
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(self.wfile)))
            except Exception:
                pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Serving {ROOT} at http://0.0.0.0:{PORT}")
    httpd.serve_forever()
