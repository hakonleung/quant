"""Test helper: seed the NestJS-canonical kline layout with
:class:`DailyBar` rows.

The production write path lives in NestJS's ``KlineWriterService``; the
Python repo is read-only. For tests we need a way to drop bars on disk
in the same layout (``<root>/<prefix>.parquet``, float64 schema) that
``FlatPrefixKlineRepo`` reads from.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pyarrow as pa
import pyarrow.parquet as pq

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

    from quant_core.domain.types.kline import DailyBar


# Mirrors apps/api/src/modules/kline/kline.row.ts::KLINE_COLUMNS — the
# canonical NestJS-owned schema.
_SCHEMA = pa.schema(
    [
        ("code", pa.string()),
        ("ts", pa.date32()),
        ("open_qfq", pa.float64()),
        ("high_qfq", pa.float64()),
        ("low_qfq", pa.float64()),
        ("close_qfq", pa.float64()),
        ("volume", pa.int64()),
        ("amount", pa.float64()),
        ("turnover_rate", pa.float64()),
        ("ma5", pa.float64()),
        ("ma10", pa.float64()),
        ("ma20", pa.float64()),
        ("ma60", pa.float64()),
    ]
)


def seed_kline_parquet(root: "Path", bars: "Iterable[DailyBar]") -> None:
    """Write ``bars`` into ``<root>/<prefix>.parquet`` files.

    Groups by ``code[:3]``; merges with anything already present at the
    same path so a test can call this multiple times.
    """
    root.mkdir(parents=True, exist_ok=True)
    by_prefix: dict[str, list[dict[str, object]]] = {}
    for bar in bars:
        row = {
            "code": bar.code,
            "ts": bar.trade_date,
            "open_qfq": float(bar.open_qfq),
            "high_qfq": float(bar.high_qfq),
            "low_qfq": float(bar.low_qfq),
            "close_qfq": float(bar.close_qfq),
            "volume": int(bar.volume),
            "amount": float(bar.amount),
            "turnover_rate": float(bar.turnover_rate),
            "ma5": float(bar.ma5) if bar.ma5 is not None else None,
            "ma10": float(bar.ma10) if bar.ma10 is not None else None,
            "ma20": float(bar.ma20) if bar.ma20 is not None else None,
            "ma60": float(bar.ma60) if bar.ma60 is not None else None,
        }
        by_prefix.setdefault(bar.code[:3], []).append(row)
    for prefix, rows in by_prefix.items():
        path = root / f"{prefix}.parquet"
        new_table = pa.Table.from_pylist(rows, schema=_SCHEMA)
        if path.exists():
            existing = pq.read_table(path)
            combined = pa.concat_tables([existing, new_table])
            # Dedup on (code, ts) keeping the latest row — same semantics
            # as NestJS's `appendBars` "last write wins per (code, ts)".
            df = combined.to_pandas()
            df = df.sort_values("ts").drop_duplicates(subset=["code", "ts"], keep="last")
            df = df.sort_values(["code", "ts"])
            new_table = pa.Table.from_pandas(df, schema=_SCHEMA, preserve_index=False)
        pq.write_table(new_table, path)
