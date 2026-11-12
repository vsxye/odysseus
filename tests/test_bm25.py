import subprocess
import sys
from pathlib import Path

from assistant.catalog import format_inr
from assistant.retrieval import BM25, cpu_score

ROOT = Path(__file__).resolve().parent.parent


def test_bm25_prefers_matching_doc():
    idx = BM25([["gaming", "laptop"], ["office", "laptop"], ["earbud"]])
    assert idx.score(["gaming"], 0) > idx.score(["gaming"], 1) == 0
    assert idx.score(["laptop"], 2) == 0


def test_cpu_score_tiers():
    assert cpu_score("Intel i3") == 0.3
    assert cpu_score("AMD Ryzen 5") == 0.6
    assert cpu_score("Intel i7") == 0.85
    assert cpu_score("AMD Ryzen 9") == 1.0


def test_inr_format():
    assert format_inr(68990) == "₹68,990"
    assert format_inr(124990) == "₹1,24,990"
    assert format_inr(999) == "₹999"


def test_offline_mode_never_imports_sdk():
    code = ("import sys, assistant; assistant.answer('best laptop under 70k', offline=True); "
            "print('anthropic' in sys.modules)")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
