"""Load test for scripts/serve.py (standard library only).

    python tests/load_test.py --base http://localhost:8040 --users 8

Scenarios
  1. chat      N concurrent /api/chat streams (+ static + health hammer in parallel).
               Measures time to {"queued"} (< 300 ms required), {"start"}, first delta, total.
  2. static    200 GETs over web/, data/products.json, web/app.js with 20 threads; all 200.
  3. health    100 GETs of /api/health with 20 threads; all 200.
  4. disconnect  2 clients hang up while queued, 1 mid-stream; server must drop them from
               the queue, keep serving, and health busy/queued must return to 0.
  5. overcap   MAX_PARALLEL+MAX_QUEUE+3 concurrent clients: exactly 3 instant busy errors,
               everyone else gets {"queued"} fast (they then hang up), no hangs.
Exit code 0 if every check passed.
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS = [
    "Which laptop is best for a college student on a budget?",
    "I need headphones for the gym, what do you suggest?",
    "Compare your two cheapest phones for battery life.",
    "What's a good monitor for photo editing?",
    "Suggest a gift under 5000 rupees for a gamer.",
    "Is there a tablet that works well for kids?",
]
CHECKS = []  # (name, ok, detail)


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    return ok


def system_prompt():
    try:
        with open(os.path.join(ROOT, "data", "products.json"), encoding="utf-8") as f:
            data = json.load(f)
        items = data if isinstance(data, list) else data.get("products", [])
        catalog = json.dumps(items[:4], ensure_ascii=False)[:1800]
    except Exception:
        catalog = "[]"
    return ("You are TechMart's product assistant. Answer in at most 2 short sentences.\n"
            "Products:\n" + catalog)


SYSTEM = system_prompt()


# --------------------------------------------------------------------------- chat client

def chat(base, prompt, hang_up=None, hang_up_delay=0.0, timeout=180):
    """Raw-socket NDJSON client. hang_up: None | 'queued' (close after first queued>0)
    | 'stream' (close after first delta) | 'after_queued' (close after first queued line).
    Returns a dict of timings in ms (None if never seen)."""
    u = urllib.parse.urlsplit(base)
    body = json.dumps({"system": SYSTEM,
                       "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    r = {"queued": None, "start": None, "first": None, "total": None, "pos0": None,
         "queued_lines": 0, "deltas": 0, "error": None, "busy": False, "hung_up": None,
         "done": False}
    t0 = time.perf_counter()
    ms = lambda: round((time.perf_counter() - t0) * 1000)
    sock = None
    try:
        sock = socket.create_connection((u.hostname, u.port or 80), timeout=10)
        sock.settimeout(timeout)
        sock.sendall(("POST /api/chat HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\n"
                      "Content-Length: %d\r\nConnection: close\r\n\r\n" % (u.netloc, len(body))
                      ).encode("ascii") + body)
        buf, headers_done = b"", False
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
            if not headers_done:
                if b"\r\n\r\n" not in buf:
                    continue
                head, buf = buf.split(b"\r\n\r\n", 1)
                status = head.split(b" ", 2)[1]
                if status != b"200":
                    r["error"] = "HTTP " + status.decode()
                    return r
                headers_done = True
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                obj = json.loads(line)
                if "queued" in obj:
                    r["queued_lines"] += 1
                    if r["queued"] is None:
                        r["queued"], r["pos0"] = ms(), obj["queued"]
                    if hang_up == "after_queued" or (hang_up == "queued" and obj["queued"] > 0):
                        time.sleep(hang_up_delay)
                        r["hung_up"] = "queued"
                        return r
                elif obj.get("start"):
                    r["start"] = ms()
                elif "delta" in obj:
                    r["deltas"] += 1
                    if r["first"] is None:
                        r["first"] = ms()
                    if hang_up == "stream":
                        r["hung_up"] = "stream"
                        return r
                elif obj.get("done"):
                    r["done"] = True
                elif "error" in obj:
                    r["error"] = obj["error"]
                    r["busy"] = obj["error"] == "busy"
                    r["retry_after"] = obj.get("retry_after")
        if not r["done"] and not r["error"]:
            r["error"] = "stream ended without done"
    except Exception as e:
        r["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        r["total"] = ms()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return r


def http_get(url, timeout=15):
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, (time.perf_counter() - t0) * 1000, body
    except urllib.error.HTTPError as e:
        return e.code, (time.perf_counter() - t0) * 1000, b""
    except Exception as e:
        return type(e).__name__, (time.perf_counter() - t0) * 1000, b""


def health(base):
    code, _, body = http_get(base + "/api/health", timeout=5)
    try:
        return code, json.loads(body)
    except Exception:
        return code, {}


def wait_idle(base, limit_s=30):
    end = time.time() + limit_s
    h = {}
    while time.time() < end:
        _, h = health(base)
        if h.get("busy") == 0 and h.get("queued") == 0:
            return True, h
        time.sleep(0.25)
    return False, h


def pct(vals, p):
    vals = sorted(v for v in vals if v is not None)
    if not vals:
        return None
    return vals[min(len(vals) - 1, int(round(p / 100.0 * (len(vals) - 1))))]


def fmt(v):
    return "-" if v is None else str(v)


# --------------------------------------------------------------------------- scenarios

def hammer(base, paths, total, threads):
    urls = [base + paths[i % len(paths)] for i in range(total)]
    with ThreadPoolExecutor(threads) as ex:
        res = list(ex.map(http_get, urls))
    codes = [c for c, _, _ in res]
    lat = [round(t) for _, t, _ in res]
    return codes, lat


def scenario_chat(base, users, limits):
    print("\n== 1. %d concurrent chats (static + health hammered at the same time) ==" % users)
    barrier = threading.Barrier(users)
    results = [None] * users

    def run(i):
        barrier.wait()
        results[i] = chat(base, PROMPTS[i % len(PROMPTS)])

    threads = [threading.Thread(target=run, args=(i,)) for i in range(users)]
    for t in threads:
        t.start()
    time.sleep(0.3)  # let the chats land in the queue first
    side = {}

    def side_load():
        side["static"] = hammer(base, ["/web/", "/data/products.json", "/web/app.js"], 200, 20)
        side["health"] = hammer(base, ["/api/health"], 100, 20)
    st = threading.Thread(target=side_load)
    st.start()
    for t in threads:
        t.join()
    st.join()

    print("%-4s %-5s %8s %8s %8s %8s %6s %7s  %s" % ("user", "pos0", "queued", "start", "1st-tok",
                                                  "total", "deltas", "q-lines", "result"))
    for i, r in enumerate(results):
        res = "busy" if r["busy"] else (r["error"] or ("ok" if r["done"] else "?"))
        print("%-4d %-5s %8s %8s %8s %8s %6d %7d  %s" % (
            i, fmt(r["pos0"]), fmt(r["queued"]), fmt(r["start"]), fmt(r["first"]),
            fmt(r["total"]), r["deltas"], r["queued_lines"], res))
    accepted = [r for r in results if not r["busy"]]
    busy = [r for r in results if r["busy"]]
    expected_busy = max(0, users - (limits["max_parallel"] + limits["max_queue"]))
    q_times = [r["queued"] for r in accepted]
    print("  time-to-queued   p50=%s  p95=%s  max=%s ms" % (pct(q_times, 50), pct(q_times, 95),
                                                           max(q_times) if q_times else None))
    print("  time-to-start    p50=%s  max=%s ms" % (pct([r["start"] for r in accepted], 50),
                                                    pct([r["start"] for r in accepted], 100)))
    print("  time-to-1st-tok  p50=%s  max=%s ms" % (pct([r["first"] for r in accepted], 50),
                                                    pct([r["first"] for r in accepted], 100)))
    print("  total            p50=%s  max=%s ms" % (pct([r["total"] for r in accepted], 50),
                                                    pct([r["total"] for r in accepted], 100)))
    print("  busy responses: %d (expected %d), max busy latency %s ms" % (
        len(busy), expected_busy, max([r["total"] for r in busy]) if busy else "-"))
    check("chat: every accepted request got {queued} < 300 ms",
          accepted and all(r["queued"] is not None and r["queued"] < 300 for r in accepted),
          "max %s ms" % (max(q_times) if q_times else "-"))
    check("chat: every accepted request finished with done",
          all(r["done"] and not r["error"] for r in accepted),
          "; ".join(sorted({str(r["error"]) for r in accepted if r["error"]})))
    check("chat: busy count == users - (parallel+queue)", len(busy) == expected_busy,
          "%d vs %d" % (len(busy), expected_busy))
    check("chat: busy answered < 300 ms", all(r["total"] < 300 for r in busy))
    waiters = [r for r in accepted if (r["pos0"] or 0) > 0 and r["start"]]
    check("chat: waiters got one {queued} line per position (pos0 .. 1)",
          all(r["queued_lines"] >= r["pos0"] for r in waiters))
    long_waiters = [r for r in waiters if r["start"] - r["queued"] > 5500]
    check("chat: keepalive every 5 s for long waiters (%d waited > 5.5 s)" % len(long_waiters),
          all(r["queued_lines"] >= max(2, (r["start"] - r["queued"]) // 5000)
              for r in long_waiters))

    for name, (codes, lat) in (("static", side["static"]), ("health", side["health"])):
        bad = [c for c in codes if c != 200]
        print("  %-6s %d requests: %d non-200, latency p50=%s p95=%s max=%s ms" % (
            name, len(codes), len(bad), pct(lat, 50), pct(lat, 95), max(lat)))
        check("%s: all %d requests 200 under chat load" % (name, len(codes)), not bad,
              str(sorted(set(map(str, bad)))))
    ok, h = wait_idle(base)
    check("chat: health busy/queued back to 0", ok, str(h))


def scenario_disconnect(base, limits):
    print("\n== 4. disconnects: 2 while queued, 1 mid-stream ==")
    P = limits["max_parallel"]
    out = {}

    long_prompt = ("Give a detailed, multi-paragraph comparison of every product you know, "
                   "covering price, specs, pros and cons, and who should buy each one.")

    def launch(name, prompt=PROMPTS[0], **kw):
        t = threading.Thread(target=lambda: out.__setitem__(name, chat(base, prompt, **kw)))
        t.start()
        return t

    def wait_for(pred, limit=10):
        end = time.time() + limit
        while time.time() < end:
            _, h = health(base)
            if pred(h):
                return True, h
            time.sleep(0.1)
        return False, h

    ts = [launch("hold%d" % i, prompt=long_prompt) for i in range(P)]
    ok, h = wait_for(lambda h: h.get("busy") == P)
    check("disconnect: %d slots filled" % P, ok, str(h))
    # queue order: D1, D2 (hang up while queued), D3 (hangs up mid-stream), B (normal)
    for name, kw in (("D1-queue", {"hang_up": "queued", "hang_up_delay": 0.3}),
                     ("D2-queue", {"hang_up": "queued", "hang_up_delay": 0.3}),
                     ("D3-stream", {"hang_up": "stream"}),
                     ("B-normal", {})):
        n_before = health(base)[1].get("queued", 0)
        ts.append(launch(name, **kw))
        wait_for(lambda h, n=n_before: h.get("queued", 0) > n, 3)
    _, h = health(base)
    print("  queued after enqueueing 4: %s" % h.get("queued"))
    ok, h = wait_for(lambda h: h.get("queued", 99) <= 2, 8)
    holds_running = not any(out.get("hold%d" % i) for i in range(P))
    check("disconnect: queue-leavers removed while slots still busy (queued<=2, busy==%d)" % P,
          ok and h.get("busy") == P and holds_running, "%s holds_running=%s" % (h, holds_running))
    for t in ts:
        t.join()
    for name in sorted(out):
        r = out[name]
        print("  %-10s pos0=%s start=%s first=%s total=%s hung_up=%s done=%s err=%s" % (
            name, r["pos0"], fmt(r["start"]), fmt(r["first"]), r["total"], r["hung_up"],
            r["done"], r["error"]))
    check("disconnect: queue-leavers never started", all(out[n]["start"] is None
                                                       for n in ("D1-queue", "D2-queue")))
    check("disconnect: mid-stream client got a delta then hung up",
          out["D3-stream"]["hung_up"] == "stream")
    check("disconnect: remaining clients completed",
          all(out[n]["done"] for n in out if n.startswith(("hold", "B-"))))
    ok, h = wait_idle(base, 15)
    check("disconnect: health busy/queued back to 0", ok, str(h))
    r = chat(base, "Thanks! Any accessories for that?")
    check("disconnect: server still serves a full chat afterwards", r["done"], str(r["error"]))
    try:
        req = urllib.request.Request(base + "/api/llm", data=json.dumps(
            {"system": SYSTEM, "user": "One-word answer: do you sell laptops?"}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            j = json.load(resp)
        check("disconnect: /api/llm (same queue) works", bool(j.get("text")), str(j)[:100])
    except Exception as e:
        check("disconnect: /api/llm (same queue) works", False, str(e))
    code, _, _ = http_get(base + "/web/")
    check("disconnect: static still 200", code == 200, str(code))


def scenario_overcap(base, limits):
    cap = limits["max_parallel"] + limits["max_queue"]
    n = cap + 3
    print("\n== 5. over capacity: %d clients vs capacity %d ==" % (n, cap))
    ok, h = wait_idle(base, 30)
    barrier = threading.Barrier(n)
    results = [None] * n

    def run(i):
        barrier.wait()
        results[i] = chat(base, PROMPTS[i % len(PROMPTS)], hang_up="after_queued", timeout=10)

    t0 = time.perf_counter()
    threads = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(15)
    wall = round((time.perf_counter() - t0) * 1000)
    hung = sum(t.is_alive() for t in threads)
    busy = [r for r in results if r and r["busy"]]
    queued = [r for r in results if r and r["queued"] is not None]
    other = [r for r in results if r and not r["busy"] and r["queued"] is None]
    print("  busy=%d queued=%d other=%d hung=%d wall=%d ms; busy latency max=%s ms; "
          "queued latency max=%s ms" % (len(busy), len(queued), len(other), hung, wall,
                                        max([r["total"] for r in busy]) if busy else "-",
                                        max([r["queued"] for r in queued]) if queued else "-"))
    check("overcap: exactly 3 busy", len(busy) == 3, str(len(busy)))
    check("overcap: busy replies instant (< 300 ms)", busy and all(r["total"] < 300 for r in busy))
    check("overcap: busy carries retry_after", busy and all(r.get("retry_after") for r in busy))
    check("overcap: no hung clients", hung == 0 and not other, "%d hung, %d other" % (hung, len(other)))
    ok, h = wait_idle(base, 20)
    check("overcap: health busy/queued back to 0 after everyone left", ok, str(h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8040")
    ap.add_argument("--users", type=int, default=8)
    ap.add_argument("--skip", default="", help="comma list of: chat,disconnect,overcap")
    a = ap.parse_args()
    base = a.base.rstrip("/")
    skip = set(filter(None, a.skip.split(",")))

    code, h = health(base)
    if code != 200:
        print("health check failed: %s %s" % (code, h))
        return 2
    limits = {"max_parallel": h.get("max_parallel", 2), "max_queue": h.get("max_queue", 8)}
    print("server: %s  model=%s  limits=%s" % (base, h.get("model"), limits))
    t0 = time.time()
    if "chat" not in skip:
        scenario_chat(base, a.users, limits)
    if "disconnect" not in skip:
        scenario_disconnect(base, limits)
    if "overcap" not in skip:
        scenario_overcap(base, limits)

    print("\n== summary (%.1f s) ==" % (time.time() - t0))
    for name, ok, detail in CHECKS:
        print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, ("  (" + detail + ")") if detail and not ok else ""))
    failed = sum(not ok for _, ok, _ in CHECKS)
    print("  %d/%d checks passed" % (len(CHECKS) - failed, len(CHECKS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
