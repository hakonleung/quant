"""Shared emit helpers: header banners + write/check semantics."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from pathlib import Path

GENERATED_BANNER_TS: Final[str] = """\
// GENERATED FILE — DO NOT EDIT BY HAND
// Source: proto/{src}
// Regenerate: pnpm gen:proto
"""

GENERATED_BANNER_PY: Final[str] = '''\
"""GENERATED FILE — DO NOT EDIT BY HAND.

Source: proto/{src}
Regenerate: pnpm gen:proto
"""
'''


def write_or_check(target: Path, content: str, *, check: bool) -> bool:
    """Write ``content`` to ``target`` (or compare in --check mode).

    Args:
        target: Output path. Parent directories are created on write.
        content: New file contents (must already include trailing newline).
        check: If True, do not write; instead return whether the file
            on disk already matches.

    Returns:
        ``True`` when the on-disk file is up-to-date (or has just been
        written). ``False`` only in ``check=True`` mode when drift exists.
    """
    if check:
        if not target.exists():
            print(f"[gen:check] missing: {target}", file=sys.stderr)
            return False
        existing = target.read_text(encoding="utf-8")
        if existing != content:
            print(f"[gen:check] out of date: {target}", file=sys.stderr)
            return False
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return True
