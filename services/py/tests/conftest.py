"""Project-wide pytest fixtures and CLI options."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from dotenv import load_dotenv
from quant_core.config import init_settings

if TYPE_CHECKING:
    from collections.abc import Iterable


# Load `.env` from the repo root once per pytest session so secrets
# (DEEPSEEK_API_KEY etc.) reach os.environ before any test or service
# constructor reads them. ``override=False`` keeps explicit
# environment-set values winning over the file.
_REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_REPO_ROOT / ".env", override=False)

# Seed the ConfigCenter with defaults so adapters that read through
# :func:`get_settings` (slack timeout, parquet lock, transport retry)
# can run in tests without each one calling init_settings themselves.
init_settings()


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--run-e2e",
        action="store_true",
        default=False,
        help="Run @pytest.mark.e2e tests (skipped by default — they hit the network or LLMs).",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: Iterable[pytest.Item]) -> None:
    if config.getoption("--run-e2e"):
        return
    skip_marker = pytest.mark.skip(reason="e2e test — pass --run-e2e to enable")
    for item in items:
        if "e2e" in item.keywords:
            item.add_marker(skip_marker)
