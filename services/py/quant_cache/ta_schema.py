"""Pyarrow schema for ``data/ta/<code>.parquet`` (beta).

Same JSON-blob trick as the sentiment cache — top-level columns are
flat and queryable; the full :class:`TaAnalysis` payload lives in a
single ``payload_json`` UTF-8 string column.
"""

from __future__ import annotations

from typing import Final

import pyarrow as pa

TA_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("asof", pa.date32()),
        ("schema_version", pa.int32()),
        ("fetched_at", pa.timestamp("us", tz="UTC")),
        ("expires_at", pa.timestamp("us", tz="UTC")),
        ("payload_json", pa.string()),
    ]
)
"""Schema of one row in ``data/ta/<code>.parquet``.

``asof`` alone is the logical primary key inside one file (``code`` is
constant per file). ``expires_at`` is computed on write so reads can
filter expired rows without a separate eviction job.
"""


TA_KEY_FIELDS: Final[tuple[str, ...]] = ("asof",)
"""Per-entity unique key inside one stock's TA parquet file."""
