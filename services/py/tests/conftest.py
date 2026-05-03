"""Project-wide pytest fixtures and CLI options."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from collections.abc import Iterable


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
