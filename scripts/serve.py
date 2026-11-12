"""Tiny local web server for the TechMart demo.

Serves the repository root (so web/ can fetch ../data/products.json),
picks a free port starting at 8000 and opens the browser at /web/.
Standard library only.
"""
import functools
import http.server
import json
import urllib.request
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("TECHMART_LOCAL_MODEL", "qwen2.5:3b")
SMALL_MODEL_HINT = (
    "\n\nStyle: reply in 3-5 short sentences of plain prose for a shopper. "
    "Never copy the catalog lines or IDs verbatim. Name the product and price, "
    "give the reason using its specs, and mention a runner-up or what was excluded if relevant."
)
LLM_LOCK = threading.Lock()  # one generation at a time on a laptop


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows sometimes maps .js to text/plain in the registry; pin the types.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".html": "text/html",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }

    # ---- local LLM bridge (Ollama) -----------------------------------
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/health":
            try:
                with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3) as r:
                    names = [m["name"] for m in json.load(r).get("models", [])]
                ok = MODEL in names
                return self._json(200 if ok else 503, {"ok": ok, "model": MODEL})
            except Exception as e:  # Ollama not running
                return self._json(503, {"ok": False, "model": MODEL, "error": str(e)})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/llm":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 200_000:
                return self._json(413, {"error": "prompt too large"})
            req = json.loads(self.rfile.read(n) or b"{}")
            payload = {
                "model": MODEL,
                "stream": False,
                "options": {"temperature": 0.2, "num_predict": 400},
                "messages": [
                    {"role": "system", "content": str(req.get("system", "")) + SMALL_MODEL_HINT},
                    {"role": "user", "content": str(req.get("user", ""))},
                ],
            }
            r = urllib.request.Request(
                OLLAMA + "/api/chat", data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with LLM_LOCK, urllib.request.urlopen(r, timeout=120) as resp:
                out = json.load(resp)
            return self._json(200, {"text": out["message"]["content"], "model": MODEL})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


def free_port(start=8000, tries=50):
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found between %d and %d" % (start, start + tries))


def main():
    port = free_port(int(os.environ.get("TECHMART_PORT", "8000")))
    handler = functools.partial(Handler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = "http://localhost:%d/web/" % port
    print()
    print("  TechMart Product Assistant is running at:  %s" % url)
    print("  Keep this window open. Close it (or press Ctrl+C) to stop.")
    print()
    sys.stdout.flush()
    if os.environ.get("TECHMART_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
