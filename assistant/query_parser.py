"""Rule-based query understanding: natural-language question -> QueryPlan."""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Sequence, Tuple

from .catalog import Product

# --------------------------------------------------------------------------- #
# Vocabulary
# --------------------------------------------------------------------------- #

STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
    "be", "it", "its", "this", "that", "do", "does", "you", "your", "i", "me", "my", "we",
    "have", "has", "what", "which", "who", "how", "can", "could", "should", "would",
    "any", "some", "there", "at", "by", "from", "as", "about", "need", "want", "looking",
    "please", "show", "tell", "give", "get", "under", "below", "within", "upto", "up",
    "max", "less", "than", "more", "over", "above", "between", "rs", "inr", "rupees",
    "budget", "best", "good", "enough", "much", "very", "really", "will", "am", "if",
    "so", "but", "not", "no", "yes", "one", "ones", "something", "anything", "suggest",
    "recommend", "recommendation", "option", "options", "carry", "sell", "stock", "buy",
    "k", "lakh", "thousand", "price", "cost", "cheap", "around", "like", "also", "just",
}

CATEGORY_SYNONYMS: List[Tuple[str, List[str]]] = [
    (r"laptops?|notebooks?|ultrabooks?", ["Laptop"]),
    (r"smart\s?phones?|phones?|mobiles?|mobile phones?|cell\s?phones?", ["Smartphone"]),
    (r"tablets?|ipads?|tabs", ["Tablet"]),
    (r"ear\s?buds?|earphones?|tws|in-ear|in ear|iems?", ["Earbuds"]),
    (r"headsets?|over-ear|over ear|on-ear", ["Headset"]),
    (r"head\s?phones?", ["Headset", "Earbuds"]),
    (r"speakers?|soundbars?", ["Speaker"]),
    (r"smart\s?watch(?:es)?|watch(?:es)?|fitness bands?|wearables?", ["Smartwatch"]),
    (r"monitors?", ["Monitor"]),
    (r"displays?|screens?", ["Monitor"]),  # only when no device category is mentioned
]
_DEVICE_CATS = {"Laptop", "Smartphone", "Tablet", "Smartwatch"}

# use case -> (regex, weighted attribute profile)
USE_CASES: Dict[str, Tuple[str, Dict[str, float]]] = {
    "video_editing": (
        r"video[\s-]?edit\w*|edit(?:ing|or)?\b|premiere|davinci|final cut|render\w*|content creat\w*|creators?|youtub\w*",
        {"ram": 0.35, "gpu": 0.35, "storage": 0.15, "cpu": 0.15},
    ),
    "gaming": (
        r"gam(?:e|es|ing|er|ers)\b|esports?|fps",
        {"gpu": 0.45, "ram": 0.25, "refresh": 0.15, "cpu": 0.15},
    ),
    "student": (
        r"students?|college|study|studying|school|universit\w*|class(?:es)?|campus",
        {"low_price": 0.35, "battery": 0.30, "light": 0.20, "ram": 0.15},
    ),
    "coding": (
        r"cod(?:e|ing|er|ers)\b|programm\w*|developers?|development|software|ide\b",
        {"ram": 0.45, "cpu": 0.30, "storage": 0.10, "battery": 0.15},
    ),
    "travel": (
        r"travel\w*|commut\w*|flights?|trips?|on the go",
        {"battery": 0.45, "light": 0.30, "anc": 0.25},
    ),
    "workout": (
        r"workouts?|gym|running|runs?\b|jog\w*|sports?|exercis\w*|fitness|sweat\w*",
        {"water": 0.5, "battery": 0.3, "low_price": 0.2},
    ),
}

# lexical query expansion per use case (used by BM25 in every stage; cheap and spec-agnostic)
USE_CASE_EXPANSIONS: Dict[str, str] = {
    "video_editing": "editing creator creators rendering render video",
    "gaming": "gaming gamers refresh aaa",
    "student": "students study college affordable featherweight light everyday",
    "coding": "performance multitasking professionals memory",
    "travel": "travel commuters noise cancellation battery",
    "workout": "sport sweatproof runs gym waterproof",
}

USE_CASE_LABELS = {
    "video_editing": "video editing",
    "gaming": "gaming",
    "student": "students",
    "coding": "coding",
    "travel": "travel",
    "workout": "workouts",
}

# superlatives -> (attribute key, descending?)
SUPERLATIVES: List[Tuple[str, Tuple[str, bool]]] = [
    (r"(?:longest|best|most|max(?:imum)?|biggest|highest|greatest)\s+(?:battery|playtime|play time|backup)", ("battery_hr", True)),
    (r"(?:cheapest|lowest[\s-]priced?|most affordable|least expensive|lowest cost)", ("price", False)),
    (r"(?:most|highest|max(?:imum)?)\s+(?:ram|memory)", ("ram_gb", True)),
    (r"(?:most|highest|max(?:imum)?|largest|biggest)\s+storage", ("storage_gb", True)),
    (r"lightest", ("weight_kg", False)),
    (r"(?:biggest|largest)\s+(?:screen|display)", ("display_in", True)),
    (r"(?:most expensive|priciest|premium-most)", ("price", True)),
]

ATTRIBUTE_QUESTIONS: List[Tuple[str, str]] = [
    (r"\bram\b|memory", "ram"),
    (r"battery|playtime|backup", "battery"),
    (r"storage|ssd|\bspace\b", "storage"),
    (r"\bgpu\b|graphics", "gpu"),
    (r"processor|\bcpu\b|chip", "cpu"),
    (r"\bprice\b|\bcost\b|how much", "price"),
    (r"weigh|heavy|light(?:weight)?\b|portable", "weight"),
    (r"screen|display", "display"),
    (r"\banc\b|noise", "anc"),
    (r"water|waterproof|ip\d", "water"),
]

KNOWN_EXTERNAL = {
    "apple", "iphone", "ipad", "macbook", "airpods", "imac", "samsung", "galaxy", "oneplus",
    "xiaomi", "redmi", "realme", "oppo", "vivo", "sony", "bose", "jbl", "sennheiser", "dell",
    "hp", "lenovo", "thinkpad", "asus", "acer", "msi", "razer", "alienware", "huawei",
    "garmin", "fitbit", "beats", "boat", "marshall", "microsoft", "surface", "nokia",
    "motorola", "pixel", "chromebook", "kindle", "logitech", "skullcandy", "jabra",
}
EXTERNAL_CATEGORY_HINT = {
    "iphone": "Smartphone", "galaxy": "Smartphone", "oneplus": "Smartphone", "pixel": "Smartphone",
    "redmi": "Smartphone", "realme": "Smartphone", "nokia": "Smartphone", "motorola": "Smartphone",
    "macbook": "Laptop", "thinkpad": "Laptop", "alienware": "Laptop", "chromebook": "Laptop",
    "airpods": "Earbuds", "ipad": "Tablet", "kindle": "Tablet", "garmin": "Smartwatch",
    "fitbit": "Smartwatch",
}
COMMON_WORDS = STOPWORDS | {
    "does", "do", "is", "are", "which", "what", "how", "i", "need", "want", "hi", "hello",
    "hey", "thanks", "ram", "gpu", "cpu", "ssd", "anc", "usb", "oled", "ips", "hdr", "inr",
    "wi-fi", "wifi", "bluetooth", "4k", "5g", "gb", "tb", "ok", "okay", "compare", "vs",
    "versus", "between", "difference", "better", "worth", "pro", "max", "plus", "ultra",
    "mini", "air", "lite", "techmart", "rupees", "video", "editing", "gaming", "coding",
    "battery", "life", "india", "indian", "english", "can", "could", "would", "should",
    "cheapest", "longest", "lightest", "wireless", "headphones", "earbuds", "laptop",
    "laptops", "phone", "phones", "tablet", "tablets", "monitor", "monitors", "speaker",
    "speakers", "watch", "smartwatch", "please", "also", "any", "and", "or", "my", "for",
}
MODEL_SUFFIX = {"pro", "max", "plus", "ultra", "mini", "air", "lite", "se", "fe", "neo", "x"}


# --------------------------------------------------------------------------- #
# QueryPlan
# --------------------------------------------------------------------------- #

@dataclass
class QueryPlan:
    question: str = ""
    categories: List[str] = field(default_factory=list)
    price_max: Optional[int] = None
    price_min: Optional[int] = None
    use_case: Optional[str] = None
    need_wireless: bool = False
    need_anc: bool = False
    keywords: List[str] = field(default_factory=list)
    expansions: List[str] = field(default_factory=list)
    pinned_ids: List[str] = field(default_factory=list)
    wants_battery: bool = False
    sort_by: Optional[str] = None
    sort_desc: bool = True
    intent: str = "search"  # search | recommend | product_question | superlative | browse | unknown_product
    asked_attributes: List[str] = field(default_factory=list)
    unknown_products: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


# --------------------------------------------------------------------------- #
# Price parsing
# --------------------------------------------------------------------------- #

_AMOUNT = (
    r"(?P<cur>₹|rs\.?|inr|rupees)?\s*"
    r"(?P<num>\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)"
    r"\s*(?P<mult>k\b|thousand\b|lakhs?\b|lacs?\b|l\b)?"
    r"(?!\s*(?:gb|tb|mb|hr|hrs|hours?|hz|mm|mp|w\b|inch|in\b|\"|%|g\b|kg|year|yr|month|day))"
    r"(?P<cur2>\s*(?:rs\.?|rupees|inr)\b)?"
)
_MAX_CUES = (
    r"under|below|less than|lesser than|within|upto|up to|max(?:imum)?(?: of)?|budget(?: of| is)?|"
    r"not more than|no more than|cheaper than|at most|<=?"
)
_MIN_CUES = r"above|over|more than|at least|minimum(?: of)?|starting(?: from| at)?|>=?|greater than"


def _to_amount(m: re.Match) -> Optional[int]:
    num = float(m.group("num").replace(",", ""))
    mult = (m.group("mult") or "").lower()
    has_cur = bool(m.group("cur") or m.group("cur2"))
    if mult in ("k", "thousand"):
        num *= 1000
    elif mult.startswith(("lakh", "lac")) or mult == "l":
        num *= 100000
    elif not has_cur and num < 1000:
        return None  # "16", "15 inch" etc. are not prices
    return int(round(num))


def parse_price(text: str) -> Tuple[Optional[int], Optional[int], str]:
    """Return (price_min, price_max, text_with_price_phrases_removed)."""
    t = text.lower()
    pmin = pmax = None
    spans: List[Tuple[int, int]] = []

    between = re.search(
        rf"between\s+{_AMOUNT.replace('?P<', '?P<a_')}\s*(?:and|to|-)\s*{_AMOUNT.replace('?P<', '?P<b_')}", t
    )
    if between:
        def amt(prefix: str) -> Optional[int]:
            class _M:  # tiny adapter so _to_amount can be reused
                def group(self, name):  # noqa: D401
                    return between.group(prefix + name)
            return _to_amount(_M())  # type: ignore[arg-type]
        a, b = amt("a_"), amt("b_")
        if a is not None and b is not None:
            pmin, pmax = min(a, b), max(a, b)
            spans.append(between.span())
    if pmax is None and pmin is None:
        rng = re.search(rf"{_AMOUNT.replace('?P<', '?P<a_')}\s*(?:-|to)\s*{_AMOUNT.replace('?P<', '?P<b_')}", t)
        if rng and (rng.group("a_cur") or rng.group("b_cur") or rng.group("a_mult") or rng.group("b_mult")):
            def amt2(prefix: str) -> Optional[int]:
                class _M:
                    def group(self, name):
                        return rng.group(prefix + name)
                return _to_amount(_M())  # type: ignore[arg-type]
            a, b = amt2("a_"), amt2("b_")
            if a is not None and b is not None:
                pmin, pmax = min(a, b), max(a, b)
                spans.append(rng.span())

    if pmax is None:
        for m in re.finditer(rf"(?:{_MAX_CUES})\s*(?:of\s*)?{_AMOUNT}", t):
            v = _to_amount(m)
            if v is not None:
                pmax = v
                spans.append(m.span())
                break
    if pmin is None:
        for m in re.finditer(rf"(?:{_MIN_CUES})\s*(?:of\s*)?{_AMOUNT}", t):
            v = _to_amount(m)
            if v is not None:
                pmin = v
                spans.append(m.span())
                break
    if pmax is None and pmin is None:
        # bare currency amount ("a ₹50,000 phone") is read as a budget ceiling
        for m in re.finditer(_AMOUNT, t):
            if m.group("cur") or m.group("cur2") or m.group("mult"):
                v = _to_amount(m)
                if v is not None:
                    pmax = v
                    spans.append(m.span())
                    break

    cleaned = text
    for s, e in sorted(spans, reverse=True):
        cleaned = cleaned[:s] + " " + cleaned[e:]
    return pmin, pmax, cleaned


# --------------------------------------------------------------------------- #
# Tokenizer (shared with BM25)
# --------------------------------------------------------------------------- #

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def stem(tok: str) -> str:
    if len(tok) > 4 and tok.endswith("ies"):
        return tok[:-3] + "y"
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok


def tokenize(text: str, drop_stopwords: bool = True) -> List[str]:
    toks = _TOKEN_RE.findall(text.lower().replace("₹", " "))
    out = []
    for t in toks:
        if drop_stopwords and t in STOPWORDS:
            continue
        out.append(stem(t))
    return out


# --------------------------------------------------------------------------- #
# Product name matching / unknown product detection
# --------------------------------------------------------------------------- #

def _norm(s: str) -> str:
    return " " + " ".join(re.findall(r"[a-z0-9]+", s.lower())) + " "


def match_products(question: str, products: Sequence[Product]) -> List[str]:
    """Pin products named in the question; the longest (most specific) name match wins."""
    """Return ids of products mentioned by (full or partial, >=2 token prefix) name."""
    q = _norm(question)
    best_len = 0
    hits: List[Tuple[int, int, str]] = []
    for p in products:
        toks = re.findall(r"[a-z0-9]+", p.name.lower())
        min_len = 1 if len(toks) == 1 else 2
        for L in range(len(toks), min_len - 1, -1):
            phrase = " " + " ".join(toks[:L]) + " "
            if phrase in q:
                full = int(L == len(toks))
                hits.append((L, full, p.id))
                best_len = max(best_len, L)
                break
    if not hits:
        return []
    top = [h for h in hits if h[0] == best_len]
    if any(h[1] for h in top):  # exact full-name match beats partial prefixes
        top = [h for h in top if h[1]]
    else:
        # partial prefix shared by several products ("NovaBook Air" vs "NovaBook Air 14"/"... 13")
        # keep them all, shortest name (= base model) first
        name_len = {p.id: len(p.name) for p in products}
        top.sort(key=lambda h: (name_len[h[2]], h[2]))
    return [h[2] for h in top]


_VOCAB_CACHE: Dict[int, set] = {}


def _catalog_vocab(products: Sequence[Product]) -> set:
    key = id(products)
    if key not in _VOCAB_CACHE:
        vocab = set()
        for p in products:
            vocab.update(re.findall(r"[a-z0-9]+", p.search_text().lower()))
        _VOCAB_CACHE[key] = vocab
    return _VOCAB_CACHE[key]


def detect_unknown_products(question: str, products: Sequence[Product]) -> List[str]:
    """Hallucination guard: product/brand-like mentions (capitalised or model-like tokens, or well-known
    external brands) whose words never occur in the catalog, so the answer can say "we don't carry X"."""
    """Find product/brand-like mentions that do not exist in the catalog."""
    vocab = _catalog_vocab(products)
    brands = {b.lower() for p in products for b in [p.brand] if b}
    raw = re.findall(r"[A-Za-z0-9][A-Za-z0-9+\-]*", question)
    found: List[str] = []
    i = 0
    unit_re = re.compile(r"^\d+(?:gb|tb|mb|hr|hrs|h|hz|mm|mp|k|w|g|in|inch|kg)?$", re.I)
    while i < len(raw):
        tok = raw[i]
        low = tok.lower()
        is_external = low in KNOWN_EXTERNAL and low not in brands
        properish = (
            (tok[0].isupper() and i > 0)
            or (any(c.isupper() for c in tok[1:]) and any(c.islower() for c in tok))
            or (re.search(r"[a-z]", low) and re.search(r"\d", low) and not unit_re.match(low))
        )
        is_unknown_proper = (
            properish
            and low not in vocab
            and low not in COMMON_WORDS
            and stem(low) not in vocab
            and not unit_re.match(low)
            and len(low) > 1
        )
        if is_external or is_unknown_proper:
            j = i + 1
            while j < len(raw):
                nxt = raw[j]
                nl = nxt.lower()
                if nl in MODEL_SUFFIX or re.match(r"^\d{1,4}[a-z]?$", nl) or (
                    nxt[0].isupper() and nl not in COMMON_WORDS and nl not in STOPWORDS
                ):
                    j += 1
                else:
                    break
            found.append(" ".join(raw[i:j]))
            i = j
        else:
            i += 1
    # de-dup, keep order
    seen, out = set(), []
    for f in found:
        if f.lower() not in seen:
            seen.add(f.lower())
            out.append(f)
    return out


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #

def parse_query(question: str, products: Sequence[Product] = ()) -> QueryPlan:
    """Turn a free-text question into a structured QueryPlan with deterministic rules.

    Rules (not an LLM) keep parsing free, instant, testable and identical to the JS web engine;
    the plan drives hard filters that the LLM could otherwise ignore or hallucinate around.
    """
    plan = QueryPlan(question=question)
    q = question.lower()

    plan.price_min, plan.price_max, cleaned = parse_price(question)

    # categories
    cats: List[str] = []
    for pattern, mapped in CATEGORY_SYNONYMS:
        if re.search(rf"\b(?:{pattern})\b", q):
            if mapped == ["Monitor"] and pattern.startswith("displays") and set(cats) & _DEVICE_CATS:
                continue
            for c in mapped:
                if c not in cats:
                    cats.append(c)
    if "Monitor" in cats and set(cats) & _DEVICE_CATS and not re.search(r"\bmonitors?\b", q):
        cats.remove("Monitor")
    plan.categories = cats

    # use case (first match in question order)
    best: Optional[Tuple[int, str]] = None
    for name, (pattern, _) in USE_CASES.items():
        m = re.search(rf"\b(?:{pattern})", q)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), name)
    plan.use_case = best[1] if best else None

    plan.need_wireless = bool(re.search(r"\bwireless\b|bluetooth|\btws\b|true wireless|cordless", q))
    plan.need_anc = bool(re.search(r"\banc\b|noise[\s-]?cancel+(?:ing|ation)?|noise[\s-]?cancel", q))
    plan.wants_battery = "battery" in q or "playtime" in q or "backup" in q

    for pattern, (attr, desc) in SUPERLATIVES:
        if re.search(rf"\b(?:{pattern})", q):
            plan.sort_by, plan.sort_desc = attr, desc
            break

    plan.asked_attributes = [name for pat, name in ATTRIBUTE_QUESTIONS if re.search(pat, q)]

    # keywords for BM25 (price phrases removed)
    kws = []
    for t in tokenize(cleaned):
        if t.isdigit() and len(t) >= 4:
            continue
        if t not in kws:
            kws.append(t)
    plan.keywords = kws
    if plan.use_case:
        plan.expansions = [t for t in dict.fromkeys(tokenize(USE_CASE_EXPANSIONS[plan.use_case])) if t not in kws]

    if products:
        plan.pinned_ids = match_products(question, products)
        plan.unknown_products = detect_unknown_products(question, products)
        for u in plan.unknown_products:
            for word in u.lower().split():
                hint = EXTERNAL_CATEGORY_HINT.get(word)
                if hint and hint not in plan.categories:
                    plan.categories.append(hint)

    # intent
    if plan.unknown_products and not plan.pinned_ids:
        plan.intent = "unknown_product"
    elif plan.pinned_ids:
        plan.intent = "product_question"
    elif plan.sort_by:
        plan.intent = "superlative"
    elif plan.use_case and re.search(r"\b(best|recommend|suggest|should i|which|ideal|top pick)\b", q):
        plan.intent = "recommend"
    elif re.search(r"\b(best|recommend|suggest|should i|ideal|top pick)\b", q):
        plan.intent = "recommend"
    elif re.search(r"what .* (?:do you have|you have|available|do you sell|do you carry)|\bshow\b|\blist\b|options", q):
        plan.intent = "browse"
    else:
        plan.intent = "search"
    return plan
