import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _no_api_key(monkeypatch):
    """Tests never touch the network: force offline mode by removing the API key."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


@pytest.fixture(scope="session")
def catalog():
    from assistant.catalog import load_catalog
    return load_catalog()


@pytest.fixture(scope="session")
def by_id(catalog):
    return {p.id: p for p in catalog}
