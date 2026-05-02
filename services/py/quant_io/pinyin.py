"""Generate ``name_pinyin`` (pinyin initials, UPPER_SNAKE) from a Chinese
company name using ``pypinyin``.

Used by every :class:`StockMetaSource` adapter so the rule lives in one
place. We strip non-Han characters before extracting initials so e.g.
``万  科Ａ`` (with full-width A and double-width spaces) yields ``WK``,
matching how brokerage UIs render ticker shortcuts.
"""

from __future__ import annotations

import re
from typing import Final

from pypinyin import Style, lazy_pinyin

# Han characters; Style.FIRST_LETTER returns just the first pinyin letter
# of each character.
_HAN_RE: Final[re.Pattern[str]] = re.compile(r"[一-鿿]+")


def name_to_pinyin_initials(name: str) -> str:
    """Return e.g. ``"GZMT"`` for ``"贵州茅台"``.

    Empty input or a name with no Han characters returns ``""``; callers
    can fall back to the raw name in that case if they care.
    """
    if not name:
        return ""
    han_only = "".join(_HAN_RE.findall(name))
    if not han_only:
        return ""
    initials = lazy_pinyin(han_only, style=Style.FIRST_LETTER)
    return "".join(c.upper() for c in initials if c)
