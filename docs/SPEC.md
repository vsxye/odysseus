# TechMart Product Assistant — shared build spec

Assignment: product Q&A assistant for TechMart (electronics retailer). Answers must come **only** from the catalog
(no invented specs/prices/products). Prices in INR (₹).

- Stage 1: question + full catalog (4 products) -> LLM answer.
  Tests: "Does the NovaBook Air have enough RAM for coding?", "Which earbuds have the longest battery life?"
- Stage 2: catalog grows to 50 products / 8 categories. Add a retrieval step before the LLM (only top-k relevant products go in the prompt).
  Tests: "I need wireless headphones under ₹10,000 with good battery life", "What laptops do you have for students?"
- Stage 3: "Which laptop is best for video editing under ₹70,000?" -> hard price filter, rank by RAM/GPU/storage (use-case aware), recommendation with a reason (not a list).
- Stage 4 (scaling decisions): documented in README — how this scales to 50k+ products.

## Repo layout (root = C:\Users\suraj\Desktop\Misc\Richik)

```
data/products.json        # 50 products (single source of truth, used by Python AND web)
assistant/                # Python package
  __init__.py
  catalog.py              # load + Product dataclass, product_to_text()
  query_parser.py         # rule-based query understanding -> QueryPlan (optional LLM parser)
  retrieval.py            # BM25 + structured filters + spec-aware scoring -> ranked products
  llm.py                  # Anthropic client wrapper + offline deterministic fallback
  assistant.py            # answer(question, stage=1|2|3) orchestrator, returns dict with trace
  cli.py                  # `python -m assistant "question"` ; flags --stage --offline --k --json
tests/                    # pytest, no network (offline mode)
web/                      # static live demo (static, no build step)
  index.html, styles.css, app.js, engine.js
index.html (root)         # redirects to web/
```

The server serves the repo root, so web fetches `../data/products.json`.

## Product schema (data/products.json = JSON array)

```json
{
  "id": "P01",
  "name": "NovaBook Air 14",
  "brand": "Nova",
  "category": "Laptop",
  "price": 52000,
  "specs": "8GB RAM, Intel i5, 512GB SSD, 10hr battery",
  "description": "One short sentence of marketing copy.",
  "attributes": {
    "ram_gb": 8, "cpu": "Intel i5", "storage_gb": 512, "gpu": null, "gpu_tier": 0,
    "battery_hr": 10, "display_in": 14, "weight_kg": 1.3
  },
  "in_stock": true
}
```

8 categories (exact strings): `Laptop, Smartphone, Tablet, Earbuds, Headset, Smartwatch, Speaker, Monitor`.

Attribute keys (include those that apply; omit irrelevant ones):
- common: `battery_hr` (number), `wireless` (bool), `weight_kg`
- compute (Laptop/Smartphone/Tablet): `ram_gb`, `cpu`, `storage_gb`, `gpu` (string|null), `gpu_tier` (0 none/integrated, 1 entry e.g. RTX 3050/MX, 2 mid e.g. RTX 4050/4060, 3 high e.g. RTX 4070+), `display_in`, `refresh_hz`
- audio (Earbuds/Headset/Speaker): `anc` (bool), `water_resistance` (e.g. "IP54" or null), `wireless` (bool), `driver_mm`
- Smartwatch: `gps` (bool), `water_resistance`, `display_in`
- Monitor: `display_in`, `resolution` ("1920x1080" / "2560x1440" / "3840x2160"), `refresh_hz`, `panel` ("IPS"/"VA"/"OLED"), `color_gamut_srgb` (percent)

The first 4 products MUST be exactly the starter catalog:
- P01 NovaBook Air 14 | Laptop | 52000 | 8GB RAM, Intel i5, 512GB SSD, 10hr battery
- P02 NovaBook Pro 15 | Laptop | 78000 | 16GB RAM, Intel i7, 1TB SSD, RTX 3050, 8hr battery
- P03 SoundCore X40 | Earbuds | 3500 | 30hr battery, ANC, IP54 water resistant (wireless true)
- P04 SoundCore Studio Pro | Headset | 8200 | 50hr battery, studio-grade ANC, foldable (wireless true)

## Retrieval / reasoning design (Python and JS must implement the SAME logic)

1. **Query parsing -> QueryPlan** `{categories[], price_max, price_min, use_case, need_wireless, need_anc, keywords[]}`
   - price: "under/below/less than/within/upto/up to/max/budget of ₹70,000 | 70k | Rs 70000 | 70,000" -> price_max; "above/over/more than" -> price_min; "between X and Y".
   - category synonyms: laptop(s)/notebook -> Laptop; phone/smartphone/mobile -> Smartphone; tablet/ipad -> Tablet;
     earbuds/earphones/tws/in-ear -> Earbuds; headset/over-ear -> Headset;
     **"headphones" -> [Headset, Earbuds]** (generic audio); speaker -> Speaker; watch/smartwatch -> Smartwatch; monitor/display/screen -> Monitor.
   - product name mention (e.g. "NovaBook Air") -> pin that product (exact/partial name match, ranked first).
   - use_case keywords -> weighted attribute profile:
     - video editing / editing / premiere / render / content creation -> laptop: ram 0.35, gpu_tier 0.35, storage 0.15, cpu 0.15
     - gaming -> gpu 0.45, ram 0.25, refresh 0.15, cpu 0.15
     - student / college / study -> value-weighted: low price 0.35, battery 0.30, weight (light) 0.20, ram 0.15
     - coding / programming / developer -> ram 0.45, cpu 0.30, storage 0.10, battery 0.15
     - travel / commute -> battery 0.45, weight 0.30, anc 0.25
     - workout / gym / running / sports -> water_resistance 0.5, battery 0.3, price 0.2
     - "good/long battery" adds battery weight 0.4 (merge).
   - cpu score: i3/Ryzen 3=0.3, i5/Ryzen 5/M-series base=0.6, i7/Ryzen 7=0.85, i9/Ryzen 9=1.0.
   - each attribute normalized 0..1 by min-max over the **candidate set** after filtering.
2. **Hard filters** (structured, applied BEFORE ranking): category in categories, price within [min,max], wireless/anc if requested.
   If filters eliminate everything, relax (drop price, keep category) and flag `relaxed: true` so the answer says nothing matched exactly.
3. **Scoring**: `score = 0.6 * spec_score(use_case profile) + 0.4 * bm25_norm` when a use_case exists, else `bm25_norm` (+ spec boosts e.g. battery if asked).
   BM25 over `name + category + brand + specs + description` (k1=1.5, b=0.75, simple lowercase tokenizer, small stopword list).
   If no category/use_case/keyword matched at all, fall back to pure BM25 top-k across catalog.
4. top_k default 5. Return each product with `score` and a `why` list (e.g. "16GB RAM (best in set)", "RTX 4050 GPU", "₹68,990 ≤ ₹70,000").
5. **Prompt**: system prompt forces catalog-only answers, cite product names + prices, say "not in our catalog" when unknown,
   for recommendation queries give ONE pick + reason + optional runner-up. Context = only the retrieved products (as compact text lines incl. computed score/why).
6. **Offline mode** (no API key): deterministic templated answer built from the ranked list (so the demo + tests work without a key).

Stage 1 mode = no retrieval, full catalog in prompt (the 4 starter products; or all products if --stage 1 is used with full data, note token cost).

LLM: Anthropic Messages API, default model `claude-haiku-5-5` (env `TECHMART_MODEL` overrides), key from `ANTHROPIC_API_KEY`.
Web: user may paste their own key (kept in memory/sessionStorage only), calls `https://api.anthropic.com/v1/messages` with headers
`x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`. Without a key -> offline answer.

## Catalog design requirements (so Stage 3 is meaningful)
- ~9 laptops spanning ₹32k–₹1.6L. Under ₹70k include: one with 16GB + RTX 4050 (~₹68,990, the correct video-editing pick),
  one with 16GB + integrated GPU (~₹61k), one 8GB with "great for watching videos" in description (a lexical trap), one cheap student laptop (~₹34k, long battery, light),
  plus ones ABOVE 70k with better specs (NovaBook Pro 15 ₹78k, a ₹1.2L+ creator laptop) that must be filtered out.
- Earbuds (~8) and Headsets (~6) with varied battery/price/ANC, several under ₹10k, a couple over ₹10k with the best battery (filter trap).
- Remaining spread across Smartphone, Tablet, Smartwatch, Speaker, Monitor. Total exactly 50. Realistic but fictional brand names (Nova, SoundCore, Zentra, Pixelon, Arcwave, Lumio, Vertex, etc.).
