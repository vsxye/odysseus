"""The five assignment queries plus relaxation / hallucination-guard checks (all offline)."""
from assistant import answer

VIDEO_Q = "Which laptop is best for video editing under ₹70,000?"
HEADPHONES_Q = "I need wireless headphones under ₹10,000 with good battery life"
STUDENTS_Q = "What laptops do you have for students?"
NOVABOOK_Q = "Does the NovaBook Air have enough RAM for coding?"
EARBUDS_Q = "Which earbuds have the longest battery life?"


def test_video_editing_top_pick(by_id):
    res = answer(VIDEO_Q, stage=3, offline=True)
    top = by_id[res["retrieved"][0]["id"]]
    assert top.id == "P05"
    assert top.attributes["ram_gb"] == 16 and top.attributes["gpu"] == "RTX 4050"
    assert top.price <= 70000
    assert all(r["price"] <= 70000 for r in res["retrieved"])
    assert all(r["category"] == "Laptop" for r in res["retrieved"])
    # recommendation style: one pick with a reason, a runner-up, and the budget exclusion
    assert res["answer"].startswith("Best pick")
    assert "Zentra Vision 15 (₹68,990)" in res["answer"]
    assert "Runner-up" in res["answer"]
    assert "NovaBook Pro 15 (₹78,000)" in res["answer"] and "over budget" in res["answer"]
    assert res["mode"] == "offline" and res["relaxed"] is False


def test_video_editing_beats_lexical_trap():
    # P07 says "great for watching videos": BM25 alone likes it, the spec profile must not
    ids = [r["id"] for r in answer(VIDEO_Q, stage=3, offline=True)["retrieved"]]
    assert ids.index("P05") < ids.index("P07")


def test_headphones_under_10k(by_id):
    res = answer(HEADPHONES_Q, stage=2, offline=True)
    assert res["retrieved"]
    for r in res["retrieved"]:
        p = by_id[r["id"]]
        assert p.category in ("Earbuds", "Headset")
        assert p.price <= 10000
        assert p.attributes.get("wireless") is True
    # best battery in budget (P21, 60hr) first; P23 (80hr but ₹18,990) is filtered out
    assert res["retrieved"][0]["id"] == "P21"
    assert "P23" not in [r["id"] for r in res["retrieved"]]
    batteries = [by_id[r["id"]].attributes["battery_hr"] for r in res["retrieved"]]
    assert batteries[0] == max(batteries)
    assert sum(batteries) / len(batteries) >= 40
    assert "Zentra Voyage ANC (₹9,499)" in res["answer"]


def test_students_only_laptops():
    for stage in (2, 3):
        res = answer(STUDENTS_Q, stage=stage, offline=True)
        assert res["retrieved"]
        assert all(r["category"] == "Laptop" for r in res["retrieved"])
        assert "P08" in [r["id"] for r in res["retrieved"][:2]]  # the student laptop ranks near the top
    assert answer(STUDENTS_Q, stage=3, offline=True)["retrieved"][0]["id"] == "P08"


def test_novabook_air_pinned():
    for stage in (1, 2, 3):
        res = answer(NOVABOOK_Q, stage=stage, offline=True)
        assert res["plan"]["pinned_ids"][0] == "P01"
        assert res["retrieved"][0]["id"] == "P01"
        a = res["answer"]
        assert "8GB" in a and "light coding" in a and "16GB" in a
    # stage 2/3 see the full catalog -> the cheapest 16GB laptop is suggested as the alternative
    assert "Pixelon Slim 14 (₹61,000)" in answer(NOVABOOK_Q, stage=3, offline=True)["answer"]


def test_earbuds_longest_battery(catalog):
    res = answer(EARBUDS_Q, stage=3, offline=True)
    best = max((p for p in catalog if p.category == "Earbuds"), key=lambda p: p.attributes["battery_hr"])
    assert res["retrieved"][0]["id"] == best.id == "P17"
    assert all(r["category"] == "Earbuds" for r in res["retrieved"])
    assert "Vertex Aura Elite" in res["answer"]


def test_stage1_uses_starter_catalog():
    res = answer(EARBUDS_Q, stage=1, offline=True)
    assert res["context_products"] == 4
    assert res["retrieved"][0]["id"] == "P03"
    assert "SoundCore X40" in res["answer"]
    assert res["prompt_tokens_est"] > 0


def test_relaxation_when_nothing_matches():
    res = answer("laptop under ₹10,000", stage=3, offline=True)
    assert res["relaxed"] is True
    assert res["retrieved"] and all(r["category"] == "Laptop" for r in res["retrieved"])
    assert "Nothing in our catalog matches exactly" in res["answer"]


def test_unknown_product_guard():
    res = answer("Does the iPhone 15 Pro have a good camera?", stage=3, offline=True)
    assert res["plan"]["unknown_products"]
    assert "We don't carry" in res["answer"] and "iPhone 15 Pro" in res["answer"]
    assert all(r["category"] == "Smartphone" for r in res["retrieved"])  # real alternatives only

    res = answer("Do you have the Zorblax Q7 speaker?", stage=3, offline=True)
    assert "We don't carry" in res["answer"] and "Zorblax Q7" in res["answer"]


def test_no_false_unknowns_for_assignment_queries():
    for q in (VIDEO_Q, HEADPHONES_Q, STUDENTS_Q, NOVABOOK_Q, EARBUDS_Q):
        assert answer(q, stage=3, offline=True)["plan"]["unknown_products"] == []


def test_result_shape():
    res = answer(VIDEO_Q)  # defaults: stage 3, auto offline (no key in tests)
    for key in ("question", "stage", "plan", "retrieved", "prompt_tokens_est", "context_products",
                "answer", "mode", "relaxed"):
        assert key in res
    assert res["stage"] == 3 and res["mode"] == "offline"
    assert set(res["retrieved"][0]) == {"id", "name", "category", "price", "score", "why"}
    assert any("RTX 4050" in w for w in res["retrieved"][0]["why"])
