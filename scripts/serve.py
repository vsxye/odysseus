"""Tiny local web server for the TechMart demo (multi-user safe).

Serves the repository root (so web/ can fetch ../data/products.json),
picks a free port starting at 8000 and opens the browser at /web/.
Bridges the web UI to a local Ollama model (streaming chat).
Standard library only, Python 3.10+.

Concurrency model
-----------------
* ThreadingHTTPServer (daemon threads, listen backlog 64): static files and
  /api/health are never blocked by model generation.
* Generations (/api/chat and /api/llm) go through one fair FIFO gate:
  at most TECHMART_MAX_PARALLEL (default 2) run at once, at most
  TECHMART_MAX_QUEUE (default 8) wait in line; beyond that a request is
  refused instantly with {"error": "busy", "retry_after": 10}.
  Waiters are served strictly in ticket order (threading.Condition).
* A slot is always released (finally), even on client disconnect or Ollama
  error; a client that disconnects while queued is removed from the line and
  its generation never starts.

Ollama parallelism
------------------
The gate lets 2 requests reach Ollama at once. They only truly run in
parallel if the Ollama *server* was started with OLLAMA_NUM_PARALLEL>=2
(e.g. `set OLLAMA_NUM_PARALLEL=2` before `ollama serve`). Otherwise Ollama
queues the second request internally, which is still safe, just slower for
the second user (they see {"start": true} but the first delta arrives later).

/api/chat NDJSON protocol (one JSON object per line)
----------------------------------------------------
  {"queued": N}      immediately on accept; N = requests ahead of you (0 = starting
                     now; a waiter is >= 1, i.e. its place in line). Repeated whenever N changes and every 5 s as a keepalive
                     (keeps proxies / Cloudflare tunnels from timing out).
  {"start": true}    generation has begun.
  {"delta": "..."}   text chunk.
  {"done": true, "model": ..., "ms": ...}
  {"error": "..."}   terminal error; {"error": "busy", "retry_after": 10} if full.

Environment
-----------
  TECHMART_PORT, TECHMART_NO_BROWSER=1, TECHMART_LOCAL_MODEL, OLLAMA_URL,
  TECHMART_MAX_PARALLEL, TECHMART_MAX_QUEUE, TECHMART_QUEUE_TIMEOUT (s, default 300).
"""
import collections
import functools
import http.client
import http.server
import json
import os
import select
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("TECHMART_LOCAL_MODEL", "qwen2.5:3b")
SMALL_MODEL_HINT = (
    "\n\nStyle: you are a friendly, chatty shopping assistant. Be concise: 2-5 short sentences "
    "or a short list. Use ONLY the products provided above; never invent products or specs. "
    "Mention prices in ₹. Never show product IDs."
)
OPTIONS = {"temperature": 0.3, "num_predict": 350, "num_ctx": 4096}
KEEP_ALIVE = "30m"


def _env_int(name, default, lo=1):
    try:
        return max(lo, int(os.environ.get(name, default)))
    except ValueError:
        return default


MAX_CONCURRENT = _env_int("TECHMART_MAX_PARALLEL", 2)
MAX_QUEUE = _env_int("TECHMART_MAX_QUEUE", 8, lo=0)
QUEUE_TIMEOUT_S = _env_int("TECHMART_QUEUE_TIMEOUT", 300)
KEEPALIVE_S = 5.0
RETRY_AFTER_S = 10
MAX_BODY = 200_000
REQUEST_READ_TIMEOUT_S = 30   # socket timeout for the browser connection
OLLAMA_CONNECT_TIMEOUT_S = 5
OLLAMA_READ_TIMEOUT_S = 60    # per chunk

WARM = False
_health = {"t": 0.0, "ok": False, "refreshing": False}
_health_lock = threading.Lock()


def log(msg):
    """One line to stderr; never raises."""
    try:
        sys.stderr.write("[serve %s] %s\n" % (time.strftime("%H:%M:%S"), str(msg).replace("\n", " ")))
        sys.stderr.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------- gate

class GenerationGate:
    """Fair FIFO queue + counting semaphore built on one Condition."""

    def __init__(self, max_active, max_queue):
        self.max_active = max_active
        self.max_queue = max_queue
        self.cond = threading.Condition()
        self.waiting = collections.deque()  # ticket numbers, FIFO
        self.active = 0
        self._next = 0

    def enter(self):
        """Take a ticket, or return None if the line is full."""
        with self.cond:
            free = max(0, self.max_active - self.active)
            if len(self.waiting) >= self.max_queue + free:
                return None
            self._next += 1
            self.waiting.append(self._next)
            return self._next

    def _try_start(self, ticket):
        if self.waiting and self.waiting[0] == ticket and self.active < self.max_active:
            self.waiting.popleft()
            self.active += 1
            self.cond.notify_all()  # everyone behind moved up
            return True
        return False

    def wait_turn(self, ticket, timeout, last_pos=None):
        """-> (started, requests_ahead). Waits at most `timeout` seconds, but
        returns at once if the position already differs from `last_pos`.
        A waiting request is always >= 1 ahead (the busy slots count), so 0
        means "starting now"."""
        with self.cond:
            if self._try_start(ticket):
                return True, 0
            pos = self.waiting.index(ticket) + 1
            if pos != last_pos or timeout <= 0:
                return False, pos
            self.cond.wait(timeout)
            if self._try_start(ticket):
                return True, 0
            return False, self.waiting.index(ticket) + 1

    def cancel(self, ticket):
        with self.cond:
            try:
                self.waiting.remove(ticket)
            except ValueError:
                return
            self.cond.notify_all()

    def release(self):
        with self.cond:
            self.active = max(0, self.active - 1)
            self.cond.notify_all()

    def stats(self):
        with self.cond:
            return self.active, len(self.waiting)


GATE = GenerationGate(MAX_CONCURRENT, MAX_QUEUE)


class ClientGone(Exception):
    pass


class QueueTimeout(Exception):
    pass


def socket_closed_by_peer(sock):
    """Non-blocking check: has the client closed its side?"""
    try:
        r, _, _ = select.select([sock], [], [], 0)
        if not r:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


def wait_for_slot(ticket, sock, on_position):
    """Block until `ticket` holds a slot. Calls on_position(n) when the position
    changes or every KEEPALIVE_S (it may raise ClientGone); between those it peeks
    the socket to notice hang-ups early. On any exception the ticket is removed
    from the line and no slot is held. On return the slot IS held (caller must
    GATE.release()); the return value says whether on_position was ever called."""
    last_pos, last_sent = None, 0.0
    deadline = time.monotonic() + QUEUE_TIMEOUT_S
    try:
        while True:
            started, pos = GATE.wait_turn(ticket, 1.0, last_pos)
            if started:
                return last_pos is not None
            now = time.monotonic()
            if pos != last_pos or now - last_sent >= KEEPALIVE_S:
                on_position(pos)
                last_pos, last_sent = pos, now
            elif socket_closed_by_peer(sock):
                raise ClientGone("closed while queued")
            if now > deadline:
                raise QueueTimeout()
    except BaseException:
        GATE.cancel(ticket)
        raise


# --------------------------------------------------------------------------- ollama

class OllamaError(Exception):
    pass


def _post(path, payload, timeout):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def ollama_open(path, payload):
    """POST to Ollama with a 5 s connect timeout and 60 s per-read timeout.
    Returns (conn, resp); caller must close both."""
    u = urllib.parse.urlsplit(OLLAMA)
    https = u.scheme == "https"
    cls = http.client.HTTPSConnection if https else http.client.HTTPConnection
    conn = cls(u.hostname, u.port or (443 if https else 80), timeout=OLLAMA_CONNECT_TIMEOUT_S)
    try:
        try:
            conn.connect()
        except socket.timeout:
            raise OllamaError("Ollama unavailable: connect timeout")
        except OSError as e:
            raise OllamaError("Ollama unavailable: %s" % (e.strerror or type(e).__name__))
        conn.sock.settimeout(OLLAMA_READ_TIMEOUT_S)
        base = u.path.rstrip("/")
        conn.request("POST", base + path, body=json.dumps(payload).encode("utf-8"),
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        if resp.status != 200:
            detail = ""
            try:
                detail = json.loads(resp.read(2000) or b"{}").get("error", "")
            except Exception:
                pass
            resp.close()
            raise OllamaError("Ollama HTTP %d%s" % (resp.status, (": " + detail) if detail else ""))
        return conn, resp
    except OllamaError:
        conn.close()
        raise
    except socket.timeout:
        conn.close()
        raise OllamaError("Ollama timed out")
    except Exception as e:
        conn.close()
        raise OllamaError("Ollama unavailable: %s" % type(e).__name__)


def ollama_chat_stream(msgs, on_delta):
    """Stream a chat; on_delta(text) per chunk (may raise ClientGone).
    Always closes the Ollama connection (which stops generation)."""
    payload = {"model": MODEL, "stream": True, "keep_alive": KEEP_ALIVE,
               "options": OPTIONS, "messages": msgs}
    conn, resp = ollama_open("/api/chat", payload)
    try:
        while True:
            try:
                raw = resp.readline()
            except socket.timeout:
                raise OllamaError("Ollama stalled (no data for %ds)" % OLLAMA_READ_TIMEOUT_S)
            except (http.client.HTTPException, OSError) as e:
                raise OllamaError("Ollama stream failed: %s" % type(e).__name__)
            if not raw:
                break
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if obj.get("error"):
                raise OllamaError("Ollama: %s" % obj["error"])
            delta = (obj.get("message") or {}).get("content", "")
            if delta:
                on_delta(delta)
            if obj.get("done"):
                break
    finally:
        try:
            resp.close()
        finally:
            conn.close()


def ollama_ok():
    """Is Ollama up with MODEL pulled? 1 s timeout, cached for 5 s.
    Only one thread refreshes at a time; others get the cached value."""
    now = time.monotonic()
    with _health_lock:
        if now - _health["t"] < 5 or _health["refreshing"]:
            return _health["ok"]
        _health["refreshing"] = True
    ok = False
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=1) as r:
            names = [m.get("name", "") for m in json.load(r).get("models", [])]
            ok = MODEL in names or (MODEL + ":latest") in names
    except Exception:
        ok = False
    finally:
        with _health_lock:
            _health.update(t=time.monotonic(), ok=ok, refreshing=False)
    return ok


def warm_up():
    """Load the model into memory so the first chat is fast."""
    global WARM
    for _ in range(30):  # Ollama may still be starting; retry for ~1 min
        try:
            with _post("/api/generate", {"model": MODEL, "prompt": "hi", "stream": False,
                                         "keep_alive": KEEP_ALIVE,
                                         "options": {"num_predict": 1}}, timeout=180) as r:
                r.read()
            WARM = True
            print("  Local model %s is warm." % MODEL)
            sys.stdout.flush()
            return
        except Exception:
            time.sleep(2)


def _messages(system, msgs):
    out = [{"role": "system", "content": str(system) + SMALL_MODEL_HINT}]
    for m in msgs or []:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant"):
            out.append({"role": m["role"], "content": str(m.get("content", ""))})
    return out


# --------------------------------------------------------------------------- http

class BadRequest(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class Handler(http.server.SimpleHTTPRequestHandler):
    timeout = REQUEST_READ_TIMEOUT_S  # applied to the client socket by StreamRequestHandler

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

    def _json(self, code, obj, headers=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            raise BadRequest(400, "bad Content-Length")
        if n < 0:
            raise BadRequest(400, "bad Content-Length")
        if n > MAX_BODY:
            raise BadRequest(413, "prompt too large")
        try:
            data = self.rfile.read(n) if n else b""
        except socket.timeout:
            raise BadRequest(408, "timed out reading request body")
        if len(data) < n:
            raise BadRequest(400, "incomplete request body")
        try:
            obj = json.loads(data or b"{}")
        except ValueError:
            raise BadRequest(400, "invalid JSON")
        if not isinstance(obj, dict):
            raise BadRequest(400, "JSON object expected")
        return obj

    def _line(self, obj):
        try:
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        except (OSError, ValueError) as e:  # BrokenPipe/ConnectionReset/Aborted/timeout
            raise ClientGone(type(e).__name__) from e

    # -- routing -----------------------------------------------------------

    def do_GET(self):
        try:
            if self.path.split("?")[0] == "/api/health":
                return self._health()
            return super().do_GET()
        except (ClientGone, ConnectionError, socket.timeout) as e:
            log("GET %s: client gone (%s)" % (self.path[:80], type(e).__name__))
            self.close_connection = True
        except Exception as e:
            log("GET %s: %s: %s" % (self.path[:80], type(e).__name__, e))
            self.close_connection = True

    def do_HEAD(self):
        try:
            return super().do_HEAD()
        except Exception as e:
            log("HEAD %s: %s: %s" % (self.path[:80], type(e).__name__, e))
            self.close_connection = True

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/chat":
                return self._chat()
            if path == "/api/llm":
                return self._llm()
            return self._json(404, {"error": "not found"})
        except (ClientGone, ConnectionError, socket.timeout) as e:
            log("POST %s: client gone (%s)" % (path[:80], type(e).__name__))
            self.close_connection = True
        except Exception as e:
            log("POST %s: %s: %s" % (path[:80], type(e).__name__, e))
            self.close_connection = True

    # -- endpoints -----------------------------------------------------------

    def _health(self):
        ok = ollama_ok()
        active, queued = GATE.stats()
        return self._json(200 if ok else 503,
                          {"ok": ok, "provider": "ollama", "model": MODEL, "warm": WARM,
                           "busy": active, "queued": queued, "max_parallel": MAX_CONCURRENT,
                           "max_queue": MAX_QUEUE})

    def _llm(self):
        """Non-streaming generation (legacy). Same FIFO gate as /api/chat."""
        try:
            req = self._read_body()
            system, user = str(req.get("system", "")), str(req.get("user", ""))
        except BadRequest as e:
            return self._json(e.code, {"error": "bad request: %s" % e})
        busy = {"error": "busy", "retry_after": RETRY_AFTER_S}
        ticket = GATE.enter()
        if ticket is None:
            return self._json(503, busy, {"Retry-After": str(RETRY_AFTER_S)})

        def on_position(_n):  # no channel to report position; just detect hang-ups
            if socket_closed_by_peer(self.connection):
                raise ClientGone("closed while queued")
        try:
            wait_for_slot(ticket, self.connection, on_position)
        except QueueTimeout:
            return self._json(503, busy, {"Retry-After": str(RETRY_AFTER_S)})
        try:
            parts = []
            t0 = time.monotonic()
            try:
                ollama_chat_stream(_messages(system, [{"role": "user", "content": user}]),
                                   parts.append)
            except OllamaError as e:
                log("/api/llm: %s" % e)
                return self._json(503, {"error": str(e)})
            return self._json(200, {"text": "".join(parts), "model": MODEL, "provider": "ollama",
                                    "ms": int((time.monotonic() - t0) * 1000)})
        finally:
            GATE.release()

    def _chat(self):
        bad = None
        try:
            req = self._read_body()
            msgs = _messages(req.get("system", ""), req.get("messages"))
            if len(msgs) < 2:
                raise BadRequest(400, "no messages")
        except BadRequest as e:
            bad = "bad request: %s" % e

        # HTTP/1.0-style stream: no Content-Length, connection closes at the end.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        if bad:
            return self._line({"error": bad})

        ticket = GATE.enter()
        if ticket is None:
            return self._line({"error": "busy", "retry_after": RETRY_AFTER_S})

        try:
            announced = wait_for_slot(ticket, self.connection,
                                      lambda n: self._line({"queued": n}))
        except QueueTimeout:
            return self._line({"error": "busy", "retry_after": RETRY_AFTER_S})
        except ClientGone:
            log("/api/chat: client left the queue (ticket %d)" % ticket)
            return
        # Slot held from here on: release it no matter what.
        try:
            if not announced:
                self._line({"queued": 0})
            self._line({"start": True})
            t0 = time.monotonic()
            try:
                ollama_chat_stream(msgs, lambda d: self._line({"delta": d}))
            except OllamaError as e:
                log("/api/chat: %s" % e)
                return self._line({"error": str(e)})
            self._line({"done": True, "model": MODEL, "ms": int((time.monotonic() - t0) * 1000)})
        except ClientGone:
            log("/api/chat: client disconnected mid-stream (ticket %d)" % ticket)
        finally:
            GATE.release()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet (access log)
        pass

    def log_error(self, fmt, *args):  # timeouts, malformed request lines
        log("%s %s" % (self.address_string(), fmt % args))


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    # On Windows SO_REUSEADDR lets two servers share a port; don't.
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        log("unhandled error from %s: %s: %s" % (client_address[0] if client_address else "?",
                                                 type(exc).__name__, exc))


class Server6(Server):
    address_family = socket.AF_INET6


def also_listen_ipv6(port, handler):
    """'localhost' often resolves to ::1 first; on Windows a refused ::1 connect
    costs ~2 s before falling back to 127.0.0.1. Listen on [::1] too (best effort)."""
    try:
        s6 = Server6(("::1", port), handler)
    except OSError:
        return None
    threading.Thread(target=s6.serve_forever, daemon=True).start()
    return s6


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
    server = Server(("127.0.0.1", port), handler)
    server6 = also_listen_ipv6(port, handler)
    url = "http://localhost:%d/web/" % port
    print()
    print("  TechMart Product Assistant is running at:  %s" % url)
    print("  Local model: %s via %s (warming up in the background)" % (MODEL, OLLAMA))
    print("  Generation slots: %d parallel, %d queued max" % (MAX_CONCURRENT, MAX_QUEUE))
    print("  Keep this window open. Close it (or press Ctrl+C) to stop.")
    print()
    sys.stdout.flush()
    threading.Thread(target=warm_up, daemon=True).start()
    if os.environ.get("TECHMART_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if server6 is not None:
            server6.server_close()


if __name__ == "__main__":
    main()
