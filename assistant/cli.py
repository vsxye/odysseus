"""Command line interface: python -m assistant "question" [--stage N] [--offline] [--k 5] [--json] [--trace]"""
from __future__ import annotations

import argparse
import json
import sys
import textwrap
from typing import Any, Dict, List, Optional

from .assistant import answer
from .catalog import format_inr

DEMO_QUERIES = [
    (1, "Does the NovaBook Air have enough RAM for coding?"),
    (1, "Which earbuds have the longest battery life?"),
    (2, "I need wireless headphones under ₹10,000 with good battery life"),
    (2, "What laptops do you have for students?"),
    (3, "Which laptop is best for video editing under ₹70,000?"),
]


def _plan_lines(plan: Dict[str, Any]) -> List[str]:
    out = []
    keys = ["intent", "categories", "price_min", "price_max", "use_case", "need_wireless", "need_anc",
            "wants_battery", "sort_by", "pinned_ids", "unknown_products", "asked_attributes", "keywords"]
    for k in keys:
        v = plan.get(k)
        if v in (None, False, [], ""):
            continue
        if k in ("price_min", "price_max"):
            v = format_inr(v)
        if k == "sort_by":
            v = f"{v} ({'desc' if plan.get('sort_desc') else 'asc'})"
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v)
        out.append(f"  {k:<17} {v}")
    return out


def _table(rows: List[Dict[str, Any]]) -> List[str]:
    if not rows:
        return ["  (none)"]
    out = [f"  {'#':<2} {'id':<4} {'name':<24} {'category':<11} {'price':>10} {'score':>6}  why"]
    for i, r in enumerate(rows, 1):
        why = "; ".join(r["why"])
        out.append(f"  {i:<2} {r['id']:<4} {r['name'][:24]:<24} {r['category']:<11} "
                   f"{format_inr(r['price']):>10} {r['score']:>6.3f}  {why}")
    return out


def render(res: Dict[str, Any], trace: bool = False) -> str:
    lines = []
    stage_desc = {1: "starter catalog P01-P04 in prompt, no retrieval",
                  2: "parse + hard filters + BM25",
                  3: "full pipeline: filters + BM25 + use-case spec scoring"}[res["stage"]]
    lines.append("=" * 100)
    lines.append(f"Q: {res['question']}")
    lines.append(f"Stage {res['stage']} ({stage_desc}) | mode: {res['mode']} | "
                 f"context: {res['context_products']} products, ~{res['prompt_tokens_est']} prompt tokens"
                 + (" | RELAXED filters" if res["relaxed"] else ""))
    lines.append("-" * 100)
    lines.append("Parsed plan:")
    lines.extend(_plan_lines(res["plan"]))
    if res.get("profile"):
        lines.append("  profile           " + ", ".join(f"{k}={v}" for k, v in res["profile"].items()))
    lines.append("")
    title = ("Ranking (reference only - stage 1 sends the whole starter catalog):" if res["stage"] == 1
             else f"Retrieved products ({len(res['retrieved'])} of {res['candidates']} candidates after filters):")
    lines.append(title)
    lines.extend(_table(res["retrieved"]))
    if res.get("excluded") and res["stage"] >= 3:
        lines.append("  excluded by budget: " + "; ".join(f"{e['name']} ({e['reason']})" for e in res["excluded"]))
    lines.append("")
    lines.append("Answer:")
    for para in res["answer"].split("\n"):
        lines.extend(textwrap.wrap(para, width=98, initial_indent="  ", subsequent_indent="  ") or [""])
    if res.get("llm_error"):
        lines.append(f"  (LLM call failed, used offline answer: {res['llm_error']})")
    if trace:
        lines.append("")
        lines.append(f"Trace: latency {res['latency_ms']} ms")
        lines.append("Prompt sent to the model (user message):")
        prompt = res["prompt"]
        if res["stage"] == 1:
            pl = prompt.split("\n")
            if len(pl) > 12:
                prompt = "\n".join(pl[:7] + [f"... ({len(pl) - 11} more lines) ..."] + pl[-4:])
        lines.extend("  | " + l for l in prompt.split("\n"))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(prog="python -m assistant", description="TechMart product Q&A assistant")
    ap.add_argument("question", nargs="?", help="customer question")
    ap.add_argument("--stage", type=int, default=3, choices=[1, 2, 3])
    ap.add_argument("--offline", action="store_true", help="force the deterministic offline answer")
    ap.add_argument("--k", type=int, default=5, help="number of products to retrieve (top-k)")
    ap.add_argument("--json", action="store_true", help="print the raw result dict as JSON")
    ap.add_argument("--trace", action="store_true", help="also print the prompt and timing")
    ap.add_argument("--demo", action="store_true", help="run the 5 assignment test queries")
    args = ap.parse_args(argv)

    offline = True if args.offline else None
    if args.demo:
        results = [answer(q, stage=s, top_k=args.k, offline=offline) for s, q in DEMO_QUERIES]
        if args.json:
            print(json.dumps(results, ensure_ascii=False, indent=2))
        else:
            print("\n\n".join(render(r, args.trace) for r in results))
        return 0
    if not args.question:
        ap.error("a question is required (or use --demo)")
    res = answer(args.question, stage=args.stage, top_k=args.k, offline=offline)
    print(json.dumps(res, ensure_ascii=False, indent=2) if args.json else render(res, args.trace))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
