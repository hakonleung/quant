"""Pack ``data/kline/*.parquet`` into a single tracked archive.

Per-code parquet files are gitignored; the archive plus ``data.json`` stamp
are checked in so a fresh clone can restore the cache by extracting
``data/kline/kline.zip`` back into ``data/kline/``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from collections.abc import Callable
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO_ROOT / "data" / "kline"
DEFAULT_ARCHIVE = "kline.zip"
STAMP_FILENAME = "data.json"


def _atomic_write_bytes(path: Path, write: Callable[[Path], None]) -> None:
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    try:
        write(tmp)
        os.replace(tmp, path)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise


def pack(root: Path, archive_name: str) -> int:
    if not root.is_dir():
        print(f"error: kline root does not exist: {root}", file=sys.stderr)
        return 2

    archive_path = root / archive_name
    stamp_path = root / STAMP_FILENAME
    excluded = {archive_path.name, stamp_path.name}

    parquet_files = sorted(
        p for p in root.iterdir() if p.is_file() and p.suffix == ".parquet" and p.name not in excluded
    )
    if not parquet_files:
        print(f"error: no parquet files under {root}", file=sys.stderr)
        return 3

    def _write_zip(target: Path) -> None:
        with zipfile.ZipFile(target, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for src in parquet_files:
                zf.write(src, arcname=src.name)

    _atomic_write_bytes(archive_path, _write_zip)

    stamp = {
        "updated_at": date.today().isoformat(),
        "file_count": len(parquet_files),
        "archive": archive_name,
    }

    def _write_stamp(target: Path) -> None:
        target.write_text(json.dumps(stamp, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    _atomic_write_bytes(stamp_path, _write_stamp)

    size_mb = archive_path.stat().st_size / (1024 * 1024)
    rel = archive_path.relative_to(REPO_ROOT) if archive_path.is_relative_to(REPO_ROOT) else archive_path
    print(f"packed {len(parquet_files)} files ({size_mb:.1f} MB) -> {rel}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help=f"kline root dir (default: {DEFAULT_ROOT.relative_to(REPO_ROOT)})",
    )
    parser.add_argument(
        "--archive",
        default=DEFAULT_ARCHIVE,
        help=f"archive filename inside root (default: {DEFAULT_ARCHIVE})",
    )
    args = parser.parse_args(argv)
    return pack(args.root.resolve(), args.archive)


if __name__ == "__main__":
    raise SystemExit(main())
