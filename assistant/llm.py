"""LLM layer: prompt building, Anthropic client wrapper (lazy import) and the
deterministic offline answer generator used when no API key is available."""
from __future__ import annotations

import os
from typing import Dict, List, Optional, Sequence, Tuple

from .catalog import Product, format_inr, product_to_text
from .query_parser import USE_CASE_LABELS, QueryPlan
from .retrieval import RetrievalResult, Scored, describe_attr, _num

DEFAULT_MODEL = "claude-haiku-5-5"

SYSTEM_PROMPT = """You are TechMart's product assistant (an Indian electronics retailer; prices in INR, ₹).
Rules:
1. Answer ONLY from the CATALOG section below. Never invent products, specs, prices or availability.
2. Always cite product names with their exact price (e.g. "Zentra Vision 15 (₹68,990)").
3. If the customer asks about a product, brand or spec that is not in the catalog, say clearly
   "We don't carry <X>" / "that is not in our catalog", then offer the closest catalog alternative if one exists.
4. For recommendation questions ("best", "which should I buy", "for <use case>") give ONE clear pick with the
   reason tied to specs, an optional runner-up with its trade-off, and mention anything excluded by the budget.
   Do not just dump a list.
5. Respect hard constraints (budget, category, wireless/ANC). If the NOTE says the filters were relaxed,
   say that nothing matched exactly before suggesting the closest options.
6. Be concise: 2-6 sentences, plain text, no markdown tables."""


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 characters per token)."""
    return max(1, round(len(text) / 4))


def build_user_prompt(question: str, context: Sequence[Tuple[Product, Optional[Scored]]],
                      plan: QueryPlan, result: Optional[RetrievalResult], stage: int) -> str:
    lines = []
    for p, s in context:
        lines.append(product_to_text(p, s.score if s else None, s.why if s else None))
    header = (f"CATALOG (full catalog, {len(lines)} products):" if stage == 1
              else f"CATALOG (top {len(lines)} products retrieved for this question; the rest of the catalog was filtered out):")
    notes = []
    if result is not None and stage >= 2:
        cons = []
        if plan.categories:
            cons.append("category " + "/".join(plan.categories))
        if plan.price_max is not None:
            cons.append(f"price ≤ {format_inr(plan.price_max)}")
        if plan.price_min is not None:
            cons.append(f"price ≥ {format_inr(plan.price_min)}")
        if plan.need_wireless:
            cons.append("wireless")
        if plan.need_anc:
            cons.append("ANC")
        if cons:
            notes.append("Hard filters applied: " + ", ".join(cons) + ".")
        if plan.use_case and stage >= 3:
            notes.append(f"Use case detected: {USE_CASE_LABELS.get(plan.use_case, plan.use_case)}; products are ranked by a spec profile for it.")
        if result.relaxed:
            notes.append(f"NOTE: filters were relaxed ({result.relaxed_note}). Tell the customer nothing matched exactly.")
        if result.excluded and stage >= 3:
            ex = ", ".join(f"{s.product.name} ({format_inr(s.product.price)})" for s in result.excluded[:2])
            notes.append(f"Excluded by budget (do not recommend): {ex}.")
    if plan.unknown_products:
        notes.append("NOTE: the customer mentioned " + ", ".join(f'"{u}"' for u in plan.unknown_products)
                     + " which is NOT in our catalog.")
    if stage >= 3 and plan.intent in ("recommend", "superlative") or (stage >= 3 and plan.use_case):
        notes.append("Give one recommendation with a reason, plus an optional runner-up.")
    body = header + "\n" + "\n".join(lines)
    if notes:
        body += "\n\n" + "\n".join(notes)
    return body + f"\n\nCUSTOMER QUESTION: {question}"


def call_llm(user_prompt: str, model: Optional[str] = None, max_tokens: int = 600) -> str:
    """Call the Anthropic Messages API. The SDK is imported lazily so offline mode never needs it."""
    import anthropic  # noqa: WPS433  (lazy import on purpose)

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    resp = client.messages.create(
        model=model or os.environ.get("TECHMART_MODEL", DEFAULT_MODEL),
        max_tokens=max_tokens,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    return "".join(getattr(b, "text", "") for b in resp.content).strip()


# --------------------------------------------------------------------------- #
# Offline deterministic answers
# --------------------------------------------------------------------------- #

def _p(p: Product) -> str:
    return f"{p.name} ({format_inr(p.price)})"


def _battery(p: Product) -> str:
    h = p.attributes.get("battery_hr")
    if h is None:
        return "no battery (mains powered)"
    if p.category == "Smartwatch" and h >= 48:
        return f"{_num(h / 24)}-day battery"
    return f"{_num(h)}hr battery"


def _highlights(p: Product, keys: Sequence[str]) -> str:
    parts = [d for d in (describe_attr(p, k) for k in keys if k != "low_price") if d]
    return ", ".join(parts) if parts else p.specs


def _profile_keys(result: RetrievalResult) -> List[str]:
    return [k for k, _ in sorted(result.profile.items(), key=lambda kv: -kv[1])]


def _budget_phrase(plan: QueryPlan) -> str:
    if plan.price_max is not None and plan.price_min is not None:
        return f" between {format_inr(plan.price_min)} and {format_inr(plan.price_max)}"
    if plan.price_max is not None:
        return f" under {format_inr(plan.price_max)}"
    if plan.price_min is not None:
        return f" above {format_inr(plan.price_min)}"
    return ""


def _cat_word(plan: QueryPlan, plural: bool = True) -> str:
    if set(plan.categories) == {"Headset", "Earbuds"}:
        return "headphones"
    if len(plan.categories) == 1:
        c = plan.categories[0].lower()
        if c == "earbuds":
            return "earbuds"
        return c + ("s" if plural else "")
    return "products" if plural else "product"


USE_CASE_REASON = {
    "video_editing": "for video editing the dedicated GPU accelerates rendering and exports, and the RAM keeps timeline scrubbing smooth",
    "gaming": "for gaming the GPU matters most, backed by RAM and a high-refresh display",
    "student": "for students it balances a low price, long battery life and a light build",
    "coding": "for coding, RAM and CPU matter most (IDEs, builds, containers)",
    "travel": "for travel, battery life, low weight and noise cancellation matter most",
    "workout": "for workouts it combines strong water/sweat resistance with good battery life at a fair price",
}


def _tradeoffs(best: Product, other: Product, keys: Sequence[str]) -> List[str]:
    out = []
    a, b = best.attributes, other.attributes
    for k in keys:
        if k == "ram" and (b.get("ram_gb") or 0) < (a.get("ram_gb") or 0):
            out.append(f"less RAM ({b.get('ram_gb')}GB vs {a.get('ram_gb')}GB)")
        elif k == "gpu" and (b.get("gpu_tier") or 0) < (a.get("gpu_tier") or 0):
            out.append(f"{b.get('gpu') or 'integrated graphics'} instead of {a.get('gpu') or 'integrated graphics'}")
        elif k == "battery" and (b.get("battery_hr") or 0) < (a.get("battery_hr") or 0):
            out.append(f"shorter battery ({_battery(other)} vs {_num(a.get('battery_hr'))}hr)")
        elif k == "storage" and (b.get("storage_gb") or 0) < (a.get("storage_gb") or 0):
            out.append(f"less storage ({describe_attr(other, 'storage')})")
        elif k == "light" and (b.get("weight_kg") or 99) > (a.get("weight_kg") or 99):
            out.append(f"heavier ({_num(b.get('weight_kg'))}kg)")
        elif k == "refresh" and (b.get("refresh_hz") or 60) < (a.get("refresh_hz") or 60):
            out.append(f"a slower {b.get('refresh_hz') or 60}Hz display")
        elif k == "anc" and a.get("anc") and not b.get("anc"):
            out.append("no ANC")
    return out


def _advantages(best: Product, other: Product, keys: Sequence[str]) -> List[str]:
    """Verb phrases describing where the runner-up beats the pick (so the trade-off is honest)."""
    out = []
    if other.price < best.price:
        out.append(f"costs {format_inr(best.price - other.price)} less")
    a, b = best.attributes, other.attributes
    if (b.get("battery_hr") or 0) > (a.get("battery_hr") or 0):
        out.append(f"has a longer battery ({_num(b['battery_hr'])}hr vs {_num(a.get('battery_hr') or 0)}hr)")
    if (b.get("storage_gb") or 0) > (a.get("storage_gb") or 0) and "storage" in keys:
        out.append(f"has more storage ({describe_attr(other, 'storage')})")
    return out


def offline_answer(plan: QueryPlan, result: RetrievalResult, products: Sequence[Product], stage: int) -> str:
    """Deterministic, template-based answer built only from ranked catalog data.

    Why: the demo and tests must work without an API key, and a templated answer can't invent specs.
    It mirrors what the LLM is instructed to do (one pick + reason, runner-up, budget exclusions).
    """
    ranked = result.ranked
    prefix = ""
    if plan.unknown_products:
        names = " or ".join(f"the {u}" for u in plan.unknown_products)
        prefix = f"We don't carry {names} — it isn't in the TechMart catalog. "
        if plan.intent == "unknown_product":
            if plan.categories and ranked:
                opts = "; ".join(f"{_p(s.product)} — {s.product.specs}" for s in ranked[:3])
                return prefix + f"Closest {_cat_word(plan)} we do stock: {opts}."
            return prefix + "I can only answer about products we stock; try asking about a category such as laptops, phones or earbuds."

    if not ranked:
        return prefix + "I couldn't find anything in our catalog that matches that question."

    if result.fallback_bm25 and all(s.bm25 == 0 for s in ranked):
        return prefix + ("I couldn't find a product in our catalog that matches that question. "
                         "We stock laptops, smartphones, tablets, earbuds, headsets, smartwatches, speakers and monitors.")

    relaxed = ""
    if result.relaxed:
        relaxed = f"Nothing in our catalog matches exactly ({result.relaxed_note}). Closest options instead. "

    if plan.intent == "product_question":
        return prefix + _product_answer(plan, result, products)
    if plan.intent == "superlative":
        return prefix + relaxed + _superlative_answer(plan, ranked)
    if stage >= 3 and (plan.use_case or plan.intent == "recommend"):
        return prefix + relaxed + _recommend_answer(plan, result)
    return prefix + relaxed + _list_answer(plan, result, stage)


def _superlative_answer(plan: QueryPlan, ranked: List[Scored]) -> str:
    top = ranked[0].product
    cat = _cat_word(plan)
    attr = plan.sort_by
    if attr == "battery_hr":
        head = f"The {cat} with the longest battery life{_budget_phrase(plan)} are the {_p(top)} with {_battery(top)}"
        if cat not in ("earbuds", "headphones", "products"):
            head = f"The {cat[:-1] if cat.endswith('s') else cat} with the longest battery life{_budget_phrase(plan)} is the {_p(top)} with {_battery(top)}"
        extra = [f"{_p(s.product)}, {_battery(s.product)}" for s in ranked[1:3]]
    elif attr == "price":
        word = "cheapest" if not plan.sort_desc else "most expensive"
        head = f"Our {word} {cat[:-1] if cat.endswith('s') else cat} is the {_p(top)} — {top.specs}"
        extra = [_p(s.product) for s in ranked[1:3]]
    else:
        label = {"ram_gb": "most RAM", "storage_gb": "most storage", "weight_kg": "lightest",
                 "display_in": "biggest screen"}.get(attr or "", "top match")
        head = f"Top pick for {label}: {_p(top)} — {top.specs}"
        extra = [f"{_p(s.product)} — {s.product.specs}" for s in ranked[1:3]]
    feats = []
    if top.attributes.get("anc"):
        feats.append("ANC")
    if top.attributes.get("water_resistance"):
        feats.append(str(top.attributes["water_resistance"]))
    if feats and attr == "battery_hr":
        head += f" ({', '.join(feats)})"
    out = head + "."
    if extra:
        out += " Next best: " + "; ".join(extra) + "."
    return out


def _recommend_answer(plan: QueryPlan, result: RetrievalResult) -> str:
    ranked = result.ranked
    keys = _profile_keys(result) or ["battery"]
    best = ranked[0].product
    budget = "" if result.relaxed else _budget_phrase(plan)
    uc = USE_CASE_LABELS.get(plan.use_case or "", "")
    title = f"Best pick{(' for ' + uc) if uc else ''}{budget}"
    out = f"{title}: {_p(best)} — {_highlights(best, keys)}."
    if plan.use_case in USE_CASE_REASON:
        reason = USE_CASE_REASON[plan.use_case]
        out += f" It scores highest on our spec profile: {reason}."
    if len(ranked) > 1:
        ru = ranked[1].product
        trade = _tradeoffs(best, ru, keys)
        adv = _advantages(best, ru, keys)
        out += f" Runner-up: {_p(ru)} — {_highlights(ru, keys)}."
        if adv and trade:
            out += f" It {' and '.join(adv)}, but has {', '.join(trade)}."
        elif adv:
            out += f" It {' and '.join(adv)}."
        elif trade:
            out += f" Trade-off: {', '.join(trade)}."
    if result.excluded and plan.price_max is not None:
        better = [s.product for s in result.excluded if s.product.price > plan.price_max][:2]
        if better:
            names = " and ".join(_p(p) for p in better)
            verb = "is" if len(better) == 1 else "are"
            out += f" Excluded: {names} {verb} over budget."
    return out


def _list_answer(plan: QueryPlan, result: RetrievalResult, stage: int) -> str:
    ranked = result.ranked
    cat = _cat_word(plan)
    budget = "" if result.relaxed else _budget_phrase(plan)
    qual = []
    if plan.need_wireless:
        qual.append("wireless")
    if plan.need_anc:
        qual.append("ANC")
    qual_s = (" ".join(qual) + " ") if qual else ""
    uc = USE_CASE_LABELS.get(plan.use_case or "", "")
    if plan.wants_battery:
        lead = f"Here are our {qual_s}{cat}{budget}, ranked by battery life and relevance:"
        items = [f"{i}. {_p(s.product)} — {_battery(s.product)}"
                 + (", ANC" if s.product.attributes.get("anc") else "") + ";"
                 for i, s in enumerate(ranked, 1)]
        items[-1] = items[-1].rstrip(";")
        top = max((s.product for s in ranked), key=lambda p: (p.attributes.get("battery_hr") or 0, -p.price))
        tail = f" Top pick: the {_p(top)}, with the longest battery in this range ({_battery(top)})."
    else:
        lead = f"Here are the {qual_s}{cat}{budget} that best match{(' for ' + uc) if uc else ''}:"
        items = [f"{i}. {_p(s.product)} — {s.product.specs};" for i, s in enumerate(ranked, 1)]
        items[-1] = items[-1].rstrip(";")
        tail = ""
        if plan.use_case == "student" and ranked:
            cheapest = min((s.product for s in ranked), key=lambda p: p.price)
            light = [s.product for s in ranked if s.product.attributes.get("weight_kg")]
            longest = max((s.product for s in ranked), key=lambda p: p.attributes.get("battery_hr") or 0)
            tail = (f" For students on a budget, the {_p(cheapest)} is the most affordable"
                    + (f"; the {longest.name} has the longest battery ({_battery(longest)})" if longest is not cheapest
                       else f" and also has the longest battery ({_battery(longest)})")
                    + ".")
            if light:
                lightest = min(light, key=lambda p: p.attributes["weight_kg"])
                tail += f" Lightest: {lightest.name} ({_num(lightest.attributes['weight_kg'])}kg)."
    return lead + " " + " ".join(items) + "." + tail


def _alternative_with(products: Sequence[Product], category: str, key: str, minimum: float,
                      exclude: str) -> Optional[Product]:
    opts = [p for p in products if p.category == category and p.id != exclude and p.in_stock
            and (p.attributes.get(key) or 0) >= minimum]
    return min(opts, key=lambda p: p.price) if opts else None


def _product_answer(plan: QueryPlan, result: RetrievalResult, products: Sequence[Product]) -> str:
    byid = {p.id: p for p in products}
    p = byid[plan.pinned_ids[0]]
    a = p.attributes
    asked = plan.asked_attributes
    uc = plan.use_case
    out = f"The {_p(p)} has {p.specs}."

    if "ram" in asked and a.get("ram_gb") is not None:
        ram = a["ram_gb"]
        need = {"video_editing": 16, "gaming": 16, "coding": 16}.get(uc or "", 8)
        if uc == "coding":
            if ram >= 16:
                verdict = f"Yes — {ram}GB RAM is comfortable for coding, including heavy IDEs, Docker containers and VMs."
            elif ram >= 8:
                verdict = (f"For light coding — VS Code, Python/JavaScript, web development and coursework — "
                           f"{ram}GB RAM is enough. For heavier work (large IDEs like IntelliJ or Android Studio, "
                           f"Docker containers, VMs, many browser tabs) 16GB is noticeably better, and the RAM is the limit here.")
            else:
                verdict = f"{ram}GB RAM is tight for coding; 16GB is recommended."
        elif uc in ("video_editing", "gaming"):
            label = USE_CASE_LABELS[uc]
            verdict = (f"{ram}GB RAM is {'good' if ram >= need else 'below the 16GB we recommend'} for {label}"
                       + ("" if ram >= need else "; expect slowdowns with larger projects") + ".")
            if p.category == "Laptop" and not a.get("gpu"):
                verdict += " It also has integrated graphics only, which limits rendering/gaming performance."
        else:
            verdict = (f"{ram}GB RAM is fine for everyday use (browsing, office, streaming)"
                       + ("; 16GB is better for heavy multitasking." if ram < 16 else " and handles heavy multitasking well."))
        out += " " + verdict
        if ram < need or (uc is None and ram < 16):
            alt = _alternative_with(products, p.category, "ram_gb", 16, p.id)
            if alt:
                extra = describe_attr(alt, "gpu") if alt.category == "Laptop" else None
                out += (f" If you need 16GB, the closest option in our catalog is the {_p(alt)} with "
                        f"{alt.attributes.get('ram_gb')}GB RAM, {alt.attributes.get('cpu')}"
                        + (f" and {extra}" if extra else "") + ".")
        return out

    if "battery" in asked:
        if a.get("battery_hr") is None:
            return out + " It has no built-in battery."
        same = [q for q in products if q.category == p.category and q.attributes.get("battery_hr")]
        best = max(same, key=lambda q: q.attributes["battery_hr"])
        out += f" That is {_battery(p)}"
        if best.id == p.id:
            out += f", the longest of any {p.category.lower()} we stock."
        else:
            out += f"; the longest-lasting {p.category.lower()} we carry is the {_p(best)} with {_battery(best)}."
        return out

    if "gpu" in asked and p.category == "Laptop":
        g = a.get("gpu")
        return out + (f" It has a dedicated {g} GPU." if g else " It uses integrated graphics (no dedicated GPU).")
    if "price" in asked:
        return f"The {p.name} costs {format_inr(p.price)} ({p.specs})." + ("" if p.in_stock else " It is currently out of stock.")
    if "anc" in asked:
        return out + (" Yes, it has active noise cancellation." if a.get("anc") else " It does not have active noise cancellation.")
    if "water" in asked:
        wr = a.get("water_resistance")
        return out + (f" It is rated {wr}." if wr else " It has no official water-resistance rating.")
    if "weight" in asked and a.get("weight_kg") is not None:
        return out + f" It weighs {_num(a['weight_kg'])}kg."
    if "storage" in asked and a.get("storage_gb") is not None:
        return out + f" It has {describe_attr(p, 'storage')}."
    if uc:
        out += f" {p.description}" if p.description else ""
    else:
        out += f" {p.description}" if p.description else ""
    if len(plan.pinned_ids) > 1:
        others = [byid[i] for i in plan.pinned_ids[1:3]]
        out += " Also matching your question: " + "; ".join(f"{_p(o)} — {o.specs}" for o in others) + "."
    return out.strip()
