"""Локальная веб-консоль для API ИС «Метафора».

Отдаёт интерфейс из папки static/ и проксирует запросы /api/v2/* на
metafora.rcsi.science, добавляя заголовок Api-Key. Ключ берётся из
переменной окружения METAFORA_API_KEY или из файла .env рядом со скриптом
и в браузер не попадает.

Запуск:  python server.py [--port 8765]
"""

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
UPSTREAM = "https://metafora.rcsi.science"
MAX_BODY = 200 * 1024 * 1024  # 200 МБ: XML выпуска + PDF


def load_env():
    env = {}
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
API_KEY = os.environ.get("METAFORA_API_KEY") or ENV.get("METAFORA_API_KEY", "")
UPSTREAM = os.environ.get("METAFORA_BASE") or ENV.get("METAFORA_BASE", UPSTREAM)


class Handler(BaseHTTPRequestHandler):
    server_version = "MetaforaConsole/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, fmt % args))

    def _send(self, status, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(status)
        if body:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    # --- статика и служебные маршруты ---
    def do_GET(self):
        if self.path.startswith("/api/v2/"):
            return self._proxy()
        if self.path == "/local/config":
            return self._json(200, {"base": UPSTREAM, "hasKey": bool(API_KEY)})
        rel = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents and target != STATIC or not target.is_file():
            return self._json(404, {"message": "Not found"})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self):
        self._route_api()

    def do_PUT(self):
        self._route_api()

    def do_DELETE(self):
        self._route_api()

    def _route_api(self):
        if self.path.startswith("/api/v2/"):
            return self._proxy()
        self._json(404, {"message": "Not found"})

    # --- прокси ---
    def _proxy(self):
        if not API_KEY:
            return self._json(500, {
                "message": "API-ключ не задан: добавьте METAFORA_API_KEY в .env",
                "error": "LOCAL_NO_API_KEY",
            })
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(413, {"message": "Слишком большой запрос", "error": "LOCAL_TOO_LARGE"})
        body = self.rfile.read(length) if length else None

        headers = {"Api-Key": API_KEY, "Accept": "application/json"}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]

        req = urllib.request.Request(UPSTREAM + self.path, data=body,
                                     headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                status, data = resp.status, resp.read()
                ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:  # сеть, таймаут, TLS
            return self._json(502, {"message": "Сервис недоступен: %s" % e, "error": "LOCAL_UPSTREAM_ERROR"})
        self._send(status, data, ctype)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("Консоль «Метафоры»: http://127.0.0.1:%d  (ключ %s)"
          % (args.port, "задан" if API_KEY else "НЕ задан"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
