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


def _load_dotenv():
    """Read KEY=VALUE lines from a gitignored .env at the repo root."""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
GEMINI_KEYS = [k.strip() for k in os.environ.get("GEMINI_API_KEYS", os.environ.get("GEMINI_API_KEY", "")).split(",") if k.strip()]
GEMINI_MODELS = [m.strip() for m in os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest,gemini-3.5-flash").split(",") if m.strip()]
_key_idx = [0]
_key_lock = threading.Lock()


def gemini_generate(system, user):
    """Call Gemini, rotating keys/models on quota, auth or server errors.
    Keys stay on this server; the browser never sees them."""
    body = json.dumps({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 600},
    }).encode()
    last = "no keys"
    for model in GEMINI_MODELS:
        for _ in range(len(GEMINI_KEYS)):
            with _key_lock:
                key = GEMINI_KEYS[_key_idx[0] % len(GEMINI_KEYS)]
            url = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/json", "x-goog-api-key": key})
            try:
                with urllib.request.urlopen(req, timeout=12) as r:
                    out = json.load(r)
                text = "".join(p.get("text", "") for p in out["candidates"][0]["content"]["parts"])
                if text.strip():
                    return text, model
                last = "empty response"
            except urllib.error.HTTPError as e:
                last = "HTTP %d" % e.code
            except Exception as e:  # timeout / network
                last = type(e).__name__
            with _key_lock:
                _key_idx[0] += 1  # try the next key
    raise RuntimeError("Gemini failed (%s)" % last)


def ollama_generate(system, user):
    payload = {
        "model": MODEL, "stream": False,
        "options": {"temperature": 0.2, "num_predict": 400},
        "messages": [{"role": "system", "content": system + SMALL_MODEL_HINT},
                     {"role": "user", "content": user}],
    }
    r = urllib.request.Request(OLLAMA + "/api/chat", data=json.dumps(payload).encode(),
                               headers={"Content-Type": "application/json"})
    with LLM_LOCK, urllib.request.urlopen(r, timeout=120) as resp:
        return json.load(resp)["message"]["content"], MODEL


def ollama_ok():
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3) as r:
            return MODEL in [m["name"] for m in json.load(r).get("models", [])]
    except Exception:
        return False


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
            if GEMINI_KEYS:
                return self._json(200, {"ok": True, "provider": "gemini", "model": GEMINI_MODELS[0]})
            ok = ollama_ok()
            return self._json(200 if ok else 503, {"ok": ok, "provider": "ollama", "model": MODEL})
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/llm":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 200_000:
                return self._json(413, {"error": "prompt too large"})
            req = json.loads(self.rfile.read(n) or b"{}")
            system, user = str(req.get("system", "")), str(req.get("user", ""))
        except Exception as e:
            return self._json(400, {"error": "bad request: %s" % e})
        errors = []
        if GEMINI_KEYS:
            try:
                text, model = gemini_generate(system, user)
                return self._json(200, {"text": text, "model": model, "provider": "gemini"})
            except Exception as e:
                errors.append(str(e))
        try:
            text, model = ollama_generate(system, user)
            return self._json(200, {"text": text, "model": model, "provider": "ollama"})
        except Exception as e:
            errors.append("Ollama: %s" % e)
        return self._json(503, {"error": "; ".join(errors)})

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
