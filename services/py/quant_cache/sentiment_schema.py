"""Pyarrow schema for the sentiment parquet files (modules/06-sentiment-analysis.md §5).

Sentiment payloads are deeply nested heterogeneous structures
(``Insight`` / ``ThemeTag`` / ``CompetitorInfo`` with their own evidence
lists). Flattening them into a strict columnar schema would force one
parquet column per nested path and recreate the data shape on every
schema bump.

Compromise — borrowed from kline:
    Top-level columns are flat and queryable (``code``, ``asof``,
    ``window_days``, ``sentiment_score``, ``expires_at`` ...). The full
    nested payload is stored as a single ``payload_json`` UTF-8 string
    column. Reads do point lookups with parquet's columnar predicate
    pushdown; the JSON blob is parsed back into the dataclass tree on
    demand. Schema migrations bump the ``schema_version`` row column —
    rows on an older version are filtered as miss at read time.
"""

from __future__ import annotations

from typing import Final

import pyarrow as pa

STOCK_SENTIMENT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("asof", pa.date32()),
        ("window_days", pa.int32()),
        ("schema_version", pa.int32()),
        ("fetched_at", pa.timestamp("us", tz="UTC")),
        ("expires_at", pa.timestamp("us", tz="UTC")),
        ("sentiment_score", pa.float64()),
        ("payload_json", pa.string()),
    ]
)
"""Schema of one row in ``data/sentiment/stock/<code>.parquet``.

* ``(code, asof, window_days)`` is the logical primary key — adapter
  enforces uniqueness on upsert.
* ``expires_at`` is computed at write time as
  ``datetime(asof + 7 days, 00:00, UTC)``. Reads filter on it so expired
  rows behave as misses without a separate eviction job.
* ``payload_json`` is the dataclass tree serialised via the same
  encoder used by the cache before this refactor (``date`` /
  ``datetime`` / ``Decimal`` are tagged via ``__type__`` markers).
"""


STOCK_SENTIMENT_KEY_FIELDS: Final[tuple[str, ...]] = ("asof", "window_days")
"""Per-entity composite key inside one stock's parquet file.

The ``code`` column is fixed for every row in a per-code file, so the
unique key inside the file is ``(asof, window_days)``."""


MARKET_SENTIMENT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("codes_hash", pa.string()),
        ("codes_canonical", pa.string()),
        ("asof", pa.date32()),
        ("window_days", pa.int32()),
        ("schema_version", pa.int32()),
        ("fetched_at", pa.timestamp("us", tz="UTC")),
        ("expires_at", pa.timestamp("us", tz="UTC")),
        ("payload_json", pa.string()),
    ]
)
"""Schema of one row in ``data/sentiment/market/<codes_hash>.parquet``.

* ``codes_hash`` is the truncated sha256 of the canonical (sorted +
  deduped) code list joined with the window — the same hash used to
  pick the parquet filename. Storing it as a column too lets cross-file
  duckdb scans recover the hash without parsing the filename.
* ``codes_canonical`` is the human-readable comma-joined code list,
  written for debuggability — never used by the read path.
"""


MARKET_SENTIMENT_KEY_FIELDS: Final[tuple[str, ...]] = ("asof", "window_days")
"""Per-hash composite key inside one market parquet file.

Same set of codes can be queried at multiple asof / window combinations;
each lives in its own row of the per-hash file."""
