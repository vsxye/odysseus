"""Retrieval: hard filters -> BM25 -> spec-aware (use-case) scoring -> ranked products."""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .catalog import Product, format_inr
from .query_parser import USE_CASES, QueryPlan, tokenize

AUDIO_CATS = {"Earbuds", "Headset", "Speaker"}

# --------------------------------------------------------------------------- #
# BM25 (k1=1.5, b=0.75)
# --------------------------------------------------------------------------- #


class BM25:
    def __init__(self, docs: Sequence[List[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs = [Counter(d) for d in docs]
        self.lens = [len(d) for d in docs]
        self.N = len(docs)
        self.avgdl = (sum(self.lens) / self.N) if self.N else 0.0
        df: Counter = Counter()
        for d in self.docs:
            df.update(d.keys())
        self.idf = {t: math.log(1 + (self.N - n + 0.5) / (n + 0.5)) for t, n in df.items()}

    def score(self, query: Sequence[str], i: int) -> float:
        d, dl = self.docs[i], self.lens[i]
        s = 0.0
        for t in query:
            tf = d.get(t, 0)
            if not tf:
                continue
            denom = tf + self.k1 * (1 - self.b + self.b * dl / (self.avgdl or 1))
            s += self.idf.get(t, 0.0) * tf * (self.k1 + 1) / denom
        return s

    def matched_terms(self, query: Sequence[str], i: int) -> List[str]:
        return [t for t in dict.fromkeys(query) if self.docs[i].get(t)]


_INDEX_CACHE: Dict[Tuple[str, ...], BM25] = {}


def get_index(products: Sequence[Product]) -> BM25:
    key = tuple(p.id for p in products)
    if key not in _INDEX_CACHE:
        _INDEX_CACHE[key] = BM25([tokenize(p.search_text()) for p in products])
    return _INDEX_CACHE[key]


# --------------------------------------------------------------------------- #
# Attribute extraction for spec scoring
# --------------------------------------------------------------------------- #


def cpu_score(cpu: Optional[str]) -> Optional[float]:
    if not cpu:
        return None
    c = cpu.lower()
    if re.search(r"i9\b|ryzen 9|ultra 9|m\d\s*max|m\d\s*ultra", c):
        return 1.0
    if re.search(r"i7\b|ryzen 7|ultra 7|m\d\s*pro", c):
        return 0.85
    if re.search(r"i5\b|ryzen 5|ultra 5|\bm\d\b", c):
        return 0.6
    if re.search(r"i3\b|ryzen 3|celeron|pentium|athlon", c):
        return 0.3
    if re.search(r"snapdragon 8|dimensity 9|a1[5-9]|tensor", c):
        return 0.85
    if re.search(r"snapdragon 7|dimensity [78]", c):
        return 0.6
    return 0.5


def water_score(wr: Optional[str]) -> Optional[float]:
    if not wr:
        return 0.0
    m = re.search(r"ip\s*[x\d](\d)", str(wr).lower())
    if m:
        return int(m.group(1)) / 8.0
    m = re.search(r"(\d+)\s*atm", str(wr).lower())
    if m:
        return min(1.0, int(m.group(1)) / 10.0)
    return 0.3


def attr_value(p: Product, key: str) -> Optional[float]:
    a = p.attributes
    if key == "ram":
        return a.get("ram_gb")
    if key == "gpu":
        return a.get("gpu_tier", 0 if p.category == "Laptop" else None)
    if key == "storage":
        return a.get("storage_gb")
    if key == "cpu":
        return cpu_score(a.get("cpu"))
    if key == "battery":
        return a.get("battery_hr")
    if key == "refresh":
        return a.get("refresh_hz", 60 if p.category in ("Laptop", "Monitor") else None)
    if key == "anc":
        return 1.0 if a.get("anc") else 0.0
    if key == "water":
        return water_score(a.get("water_resistance"))
    if key == "low_price":
        return -float(p.price)
    if key == "light":
        w = a.get("weight_kg")
        return -float(w) if w is not None else None
    return a.get(key)


def normalized(products: Sequence[Product], key: str) -> Dict[str, float]:
    """Min-max normalise an attribute over the *candidate set*, so "best" means best among eligible products."""
    vals = {p.id: attr_value(p, key) for p in products}
    present = [float(v) for v in vals.values() if v is not None]
    if not present:
        return {pid: 0.0 for pid in vals}
    lo, hi = min(present), max(present)
    out = {}
    for pid, v in vals.items():
        if v is None:
            out[pid] = 0.0
        elif hi == lo:
            out[pid] = 1.0
        else:
            out[pid] = (float(v) - lo) / (hi - lo)
    return out


def describe_attr(p: Product, key: str) -> Optional[str]:
    a = p.attributes
    if key == "ram" and a.get("ram_gb") is not None:
        return f"{a['ram_gb']}GB RAM"
    if key == "gpu" and p.category == "Laptop":
        return f"{a['gpu']} GPU" if a.get("gpu") else "integrated graphics"
    if key == "storage" and a.get("storage_gb") is not None:
        s = a["storage_gb"]
        return f"{s // 1024}TB storage" if s >= 1024 and s % 1024 == 0 else f"{s}GB storage"
    if key == "cpu" and a.get("cpu"):
        return str(a["cpu"])
    if key == "battery" and a.get("battery_hr") is not None:
        return f"{_num(a['battery_hr'])}hr battery"
    if key == "refresh" and a.get("refresh_hz"):
        return f"{a['refresh_hz']}Hz display"
    if key == "anc":
        return "ANC" if a.get("anc") else "no ANC"
    if key == "water":
        return f"{a['water_resistance']} water resistance" if a.get("water_resistance") else "no water rating"
    if key == "low_price":
        return format_inr(p.price)
    if key == "light" and a.get("weight_kg") is not None:
        return f"{_num(a['weight_kg'])}kg"
    return None


def _num(x) -> str:
    return str(int(x)) if float(x).is_integer() else str(x)


# --------------------------------------------------------------------------- #
# Retrieval
# --------------------------------------------------------------------------- #


@dataclass
class Scored:
    product: Product
    score: float
    bm25: float = 0.0
    spec: float = 0.0
    why: List[str] = field(default_factory=list)
    pinned: bool = False

    def to_dict(self) -> Dict:
        p = self.product
        return {
            "id": p.id, "name": p.name, "category": p.category, "price": p.price,
            "score": round(self.score, 4), "why": list(self.why),
        }


@dataclass
class RetrievalResult:
    ranked: List[Scored]
    candidates: int
    excluded: List[Scored]  # same-category products removed by the price filter (best specs first)
    relaxed: bool = False
    relaxed_note: str = ""
    profile: Dict[str, float] = field(default_factory=dict)
    fallback_bm25: bool = False


def build_profile(plan: QueryPlan, stage: int) -> Dict[str, float]:
    """Merge the use-case weights (stage 3 only) with explicit asks like "good battery", normalised to 1."""
    profile: Dict[str, float] = {}
    if stage >= 3 and plan.use_case:
        profile.update(USE_CASES[plan.use_case][1])
    if plan.wants_battery:
        profile["battery"] = profile.get("battery", 0.0) + 0.4
    total = sum(profile.values())
    return {k: v / total for k, v in profile.items()} if total else {}


def _passes(p: Product, plan: QueryPlan, use_price: bool = True, use_flags: bool = True) -> bool:
    if plan.categories and p.category not in plan.categories:
        return False
    if use_price:
        if plan.price_max is not None and p.price > plan.price_max:
            return False
        if plan.price_min is not None and p.price < plan.price_min:
            return False
    if use_flags:
        audio = p.category in AUDIO_CATS
        if plan.need_wireless and audio and p.attributes.get("wireless") is not True:
            return False
        if plan.need_anc and (audio or not plan.categories) and not p.attributes.get("anc"):
            return False
    return True


def _price_constraint_text(plan: QueryPlan) -> str:
    if plan.price_min is not None and plan.price_max is not None:
        return f"between {format_inr(plan.price_min)} and {format_inr(plan.price_max)}"
    if plan.price_max is not None:
        return f"under {format_inr(plan.price_max)}"
    if plan.price_min is not None:
        return f"above {format_inr(plan.price_min)}"
    return ""


def retrieve(products: Sequence[Product], plan: QueryPlan, stage: int = 3, top_k: int = 5) -> RetrievalResult:
    """Rank catalog products for a QueryPlan.

    Why this order: hard constraints (category, budget, wireless/ANC) are applied *before* ranking so
    no amount of lexical similarity can surface an over-budget product; BM25 then measures topical
    relevance, and (stage 3) a use-case spec profile ranks by the attributes that actually matter
    (e.g. RAM+GPU for video editing) so marketing copy like "great for watching videos" can't win.
    If filters leave nothing, the price filter is relaxed (category kept) and `relaxed` is flagged.
    """
    index = get_index(products)
    pos = {p.id: i for i, p in enumerate(products)}

    # 1. hard filters (with relaxation)
    relaxed, note = False, ""
    cands = [p for p in products if _passes(p, plan)]
    if not cands and (plan.price_max is not None or plan.price_min is not None):
        cands = [p for p in products if _passes(p, plan, use_price=False)]
        relaxed = True
        note = f"nothing matched {_price_constraint_text(plan)}; price filter dropped"
    if not cands and (plan.need_wireless or plan.need_anc):
        cands = [p for p in products if _passes(p, plan, use_price=False, use_flags=False)]
        relaxed = True
        note = "nothing matched all requirements; price/feature filters dropped"
    if not cands:
        cands = list(products)
        relaxed = bool(plan.categories)
        note = note or "no matching category; searched the whole catalog"

    # pinned products are always candidates
    for pid in plan.pinned_ids:
        if pid not in {p.id for p in cands}:
            cands.append(products[pos[pid]])

    # 2. BM25 over candidates (IDF from the full catalog)
    query_terms = list(plan.keywords) + [t for t in plan.expansions if t not in plan.keywords]
    raw_bm25 = {p.id: index.score(query_terms, pos[p.id]) for p in cands}
    max_bm = max(raw_bm25.values()) if raw_bm25 else 0.0
    bm25_norm = {pid: (s / max_bm if max_bm > 0 else 0.0) for pid, s in raw_bm25.items()}

    # 3. spec-aware scoring
    profile = build_profile(plan, stage)
    use_case_profile = bool(stage >= 3 and plan.use_case)
    norms = {k: normalized(cands, k) for k in profile}
    fallback = not plan.categories and not plan.use_case and max_bm == 0 and not plan.pinned_ids

    scored: List[Scored] = []
    for p in cands:
        spec = sum(w * norms[k][p.id] for k, w in profile.items())
        bm = bm25_norm[p.id]
        if not profile:
            score = bm
        elif use_case_profile:
            score = 0.6 * spec + 0.4 * bm
        else:  # only an explicit attribute boost (e.g. "good battery"): let the spec dominate
            score = 0.7 * spec + 0.3 * bm
        s = Scored(product=p, score=score, bm25=bm, spec=spec)
        s.pinned = p.id in plan.pinned_ids
        s.why = _why(p, plan, profile, norms, index, pos[p.id], s.pinned)
        scored.append(s)

    def key(s: Scored):
        pin_rank = plan.pinned_ids.index(s.product.id) if s.pinned else len(plan.pinned_ids)
        sort_val = 0.0
        if plan.sort_by:
            v = s.product.price if plan.sort_by == "price" else s.product.attributes.get(plan.sort_by)
            if v is None:
                sort_val = math.inf
            else:
                sort_val = -float(v) if plan.sort_desc else float(v)
        return (pin_rank, sort_val, -s.score, s.product.price, s.product.id)

    if relaxed and plan.price_max is not None and not plan.sort_by and not plan.pinned_ids:
        # the budget could not be met: the most useful fallback is "closest to your budget"
        scored.sort(key=lambda s: (s.product.price, -s.score))
    else:
        scored.sort(key=key)

    # 4. products excluded by the price filter (for "Excluded: ... over budget" explanations)
    excluded: List[Scored] = []
    if not relaxed and (plan.price_max is not None or plan.price_min is not None) and plan.categories:
        out = [p for p in products if _passes(p, plan, use_price=False) and not _passes(p, plan)]
        if out:
            pool = list(cands) + out
            ex_norms = {k: normalized(pool, k) for k in profile}
            for p in out:
                spec = sum(w * ex_norms[k][p.id] for k, w in profile.items())
                excluded.append(Scored(product=p, score=spec, spec=spec,
                                       why=[_price_fail(p, plan)]))
            # nearest-to-budget first: "the ones you'd consider if you stretched the budget"
            excluded.sort(key=lambda s: (abs(s.product.price - (plan.price_max or plan.price_min or 0)), -s.spec))

    return RetrievalResult(
        ranked=scored[:top_k] if top_k else scored,
        candidates=len(cands),
        excluded=excluded,
        relaxed=relaxed,
        relaxed_note=note,
        profile=profile,
        fallback_bm25=fallback,
    )


def _price_fail(p: Product, plan: QueryPlan) -> str:
    if plan.price_max is not None and p.price > plan.price_max:
        return f"{format_inr(p.price)} > {format_inr(plan.price_max)} (over budget)"
    if plan.price_min is not None and p.price < plan.price_min:
        return f"{format_inr(p.price)} < {format_inr(plan.price_min)} (below range)"
    return ""


def _why(p: Product, plan: QueryPlan, profile: Dict[str, float], norms: Dict[str, Dict[str, float]],
         index: BM25, i: int, pinned: bool) -> List[str]:
    why: List[str] = []
    if pinned:
        why.append("name match")
    for k, w in sorted(profile.items(), key=lambda kv: -kv[1]):
        if w < 0.1:
            continue
        d = describe_attr(p, k)
        if not d:
            continue
        n = norms[k].get(p.id, 0.0)
        if n >= 0.999 and len({round(v, 6) for v in norms[k].values()}) > 1:
            label = {"low_price": "lowest price in set", "light": "lightest in set"}.get(k, "best in set")
            d += f" ({label})"
        why.append(d)
    if plan.sort_by and plan.sort_by != "price":
        v = p.attributes.get(plan.sort_by)
        if v is not None and not any(plan.sort_by.split("_")[0] in x.lower() for x in why):
            unit = {"battery_hr": "hr battery", "ram_gb": "GB RAM", "storage_gb": "GB storage",
                    "weight_kg": "kg", "display_in": "-inch display"}.get(plan.sort_by, "")
            why.append(f"{_num(v)}{unit}")
    if plan.price_max is not None and p.price <= plan.price_max:
        why.append(f"{format_inr(p.price)} ≤ {format_inr(plan.price_max)}")
    elif plan.price_min is not None and p.price >= plan.price_min:
        why.append(f"{format_inr(p.price)} ≥ {format_inr(plan.price_min)}")
    if plan.need_wireless and p.attributes.get("wireless"):
        why.append("wireless")
    if plan.need_anc and p.attributes.get("anc"):
        why.append("ANC")
    terms = index.matched_terms(list(plan.keywords) + list(plan.expansions), i)
    if terms:
        why.append("matches: " + ", ".join(terms[:4]))
    return why
