"""Catalog loading: Product dataclass, JSON loader, compact text rendering."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CATALOG_PATH = REPO_ROOT / "data" / "products.json"

CATEGORIES = [
    "Laptop", "Smartphone", "Tablet", "Earbuds",
    "Headset", "Smartwatch", "Speaker", "Monitor",
]


@dataclass
class Product:
    id: str
    name: str
    brand: str
    category: str
    price: int
    specs: str
    description: str = ""
    attributes: Dict[str, Any] = field(default_factory=dict)
    in_stock: bool = True

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Product":
        return cls(
            id=str(d["id"]),
            name=str(d["name"]),
            brand=str(d.get("brand", "")),
            category=str(d["category"]),
            price=int(round(float(d["price"]))),
            specs=str(d.get("specs", "")),
            description=str(d.get("description", "")),
            attributes=dict(d.get("attributes") or {}),
            in_stock=bool(d.get("in_stock", True)),
        )

    def attr(self, key: str, default: Any = None) -> Any:
        return self.attributes.get(key, default)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def search_text(self) -> str:
        """Text indexed by BM25."""
        return " ".join([self.name, self.category, self.brand, self.specs, self.description])


def format_inr(amount: float) -> str:
    """Format an amount with Indian digit grouping: 124990 -> '₹1,24,990'."""
    n = int(round(amount))
    neg = n < 0
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return ("-" if neg else "") + "₹" + s


def product_to_text(p: Product, score: Optional[float] = None, why: Optional[List[str]] = None) -> str:
    """Compact single-line representation used in LLM prompts."""
    parts = [p.id, p.name, p.category, format_inr(p.price), p.specs]
    if p.description:
        parts.append(p.description)
    parts.append("in stock" if p.in_stock else "OUT OF STOCK")
    line = " | ".join(parts)
    if score is not None:
        line += f" | relevance {score:.2f}"
    if why:
        line += " | why: " + "; ".join(why)
    return line


_CACHE: Dict[str, List[Product]] = {}


def catalog_path() -> Path:
    env = os.environ.get("TECHMART_CATALOG")
    return Path(env) if env else DEFAULT_CATALOG_PATH


def load_catalog(path: Optional[os.PathLike] = None) -> List[Product]:
    p = Path(path) if path else catalog_path()
    key = str(p.resolve())
    if key not in _CACHE:
        with open(p, encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict) and "products" in raw:
            raw = raw["products"]
        _CACHE[key] = [Product.from_dict(d) for d in raw]
    return _CACHE[key]
