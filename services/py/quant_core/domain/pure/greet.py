"""Smoke pure function. Mirrors apps/web/lib/fp/greet.ts so the test pipeline
has a non-trivial target on both sides. Will be deleted in F1 once real
domain functions exist.
"""

from __future__ import annotations

from quant_core.errors import QuantError


def greet(name: str) -> str:
    """Return a greeting for ``name``.

    Args:
        name: Non-empty subject of the greeting.

    Returns:
        A greeting string ``"Hello, {name}"``.

    Raises:
        QuantError: ``code="INVALID_ARGUMENT"`` when ``name`` is empty.
    """
    if not name:
        raise QuantError("INVALID_ARGUMENT", "greet: name must be non-empty")
    return f"Hello, {name}"
