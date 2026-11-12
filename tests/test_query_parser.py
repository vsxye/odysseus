import pytest

from assistant.query_parser import parse_price, parse_query


@pytest.mark.parametrize("text,pmax", [
    ("laptop under ₹70,000", 70000),
    ("laptop under 70k", 70000),
    ("headphones below Rs. 10000", 10000),
    ("earbuds under 10,000", 10000),
    ("phone within rs 25000", 25000),
    ("budget of ₹1.5 lakh", 150000),
    ("upto 50K please", 50000),
    ("a ₹40,000 phone", 40000),
])
def test_price_max(text, pmax):
    pmin, got, _ = parse_price(text)
    assert got == pmax
    assert pmin is None


def test_price_min_and_between():
    assert parse_price("laptops above ₹1,00,000")[0] == 100000
    pmin, pmax, _ = parse_price("phones between 20k and 30k")
    assert (pmin, pmax) == (20000, 30000)


def test_specs_are_not_prices():
    # "16GB", "15 inch" or "more than 16GB RAM" must not be read as a budget
    assert parse_price("laptop with more than 16GB RAM")[:2] == (None, None)
    assert parse_price("15 inch laptop under 2 kg")[:2] == (None, None)


def test_categories_and_flags(catalog):
    plan = parse_query("I need wireless headphones under ₹10,000 with good battery life", catalog)
    assert set(plan.categories) == {"Headset", "Earbuds"}
    assert plan.price_max == 10000
    assert plan.need_wireless and plan.wants_battery


def test_watching_is_not_watch(catalog):
    assert parse_query("laptop for watching movies", catalog).categories == ["Laptop"]


def test_use_case_detection(catalog):
    assert parse_query("Which laptop is best for video editing under ₹70,000?", catalog).use_case == "video_editing"
    assert parse_query("What laptops do you have for students?", catalog).use_case == "student"
    assert parse_query("good laptop for coding", catalog).use_case == "coding"


def test_product_pinning(catalog):
    assert parse_query("Does the NovaBook Air have enough RAM for coding?", catalog).pinned_ids == ["P01"]
    assert parse_query("Tell me about the Nova Phone 12 Pro", catalog).pinned_ids == ["P30"]
    assert parse_query("Tell me about the Nova Phone 12", catalog).pinned_ids == ["P24"]
