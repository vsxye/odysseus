"""Orchestrator: question -> QueryPlan -> retrieval -> prompt -> LLM (or offline) answer."""
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional, Sequence

from .catalog import Product, load_catalog
from .llm import (SYSTEM_PROMPT, build_user_prompt, call_llm, estimate_tokens,
                  offline_answer)
from .query_parser import parse_query
from .retrieval import retrieve

STARTER_IDS = ("P01", "P02", "P03", "P04")  # the original Stage 1 catalog


def answer(question: str, stage: int = 3, top_k: int = 5, offline: Optional[bool] = None,
           products: Optional[Sequence[Product]] = None) -> Dict[str, Any]:
    """Answer a customer question from the catalog.

    stage 1: starter catalog (P01-P04) pasted whole into the prompt (no retrieval)
    stage 2: parse + hard filters + BM25 (+ battery boost / superlative sort), top-k in the prompt
    stage 3: full pipeline incl. use-case spec profiles and recommendation-style answers
    offline: None = auto (offline when ANTHROPIC_API_KEY is not set)
    """
    if stage not in (1, 2, 3):
        raise ValueError("stage must be 1, 2 or 3")
    t0 = time.perf_counter()
    catalog = list(products) if products is not None else load_catalog()
    if stage == 1:
        # Stage 1 reproduces the assignment's starting point: the 4-product starter catalog
        # pasted whole into the prompt. Retrieval only becomes necessary once the catalog grows.
        starter = [p for p in catalog if p.id in STARTER_IDS]
        catalog = starter or catalog
    if offline is None:
        offline = not os.environ.get("ANTHROPIC_API_KEY")

    plan = parse_query(question, catalog)
    # Stage 1 has no retrieval in the prompt; the ranking is still computed over the whole
    # catalog so the trace (and the offline answer, which plays the LLM's role) can use it.
    result = retrieve(catalog, plan, stage=3 if stage == 1 else stage, top_k=top_k)

    if stage == 1:
        context = [(p, None) for p in catalog]
    else:
        context = [(s.product, s) for s in result.ranked]

    user_prompt = build_user_prompt(question, context, plan, result if stage >= 2 else None, stage)
    tokens = estimate_tokens(SYSTEM_PROMPT + "\n" + user_prompt)

    mode, error = "offline", None
    if offline:
        text = offline_answer(plan, result, catalog, stage)
    else:
        try:
            text = call_llm(user_prompt)
            mode = "llm"
        except Exception as exc:  # network/key/SDK problems -> deterministic fallback
            error = f"{type(exc).__name__}: {exc}"
            text = offline_answer(plan, result, catalog, stage)

    out: Dict[str, Any] = {
        "question": question,
        "stage": stage,
        "plan": plan.to_dict(),
        "retrieved": [s.to_dict() for s in result.ranked],
        "excluded": [{"id": s.product.id, "name": s.product.name, "price": s.product.price,
                      "reason": s.why[0] if s.why else ""} for s in result.excluded[:3]],
        "prompt_tokens_est": tokens,
        "context_products": len(context),
        "answer": text,
        "mode": mode,
        "relaxed": result.relaxed,
        "candidates": result.candidates,
        "profile": {k: round(v, 3) for k, v in result.profile.items()},
        "prompt": user_prompt,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
    if error:
        out["llm_error"] = error
    return out
