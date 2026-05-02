"""Concrete contract test for :class:`FileKeyValueStore` plus adapter-only checks."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted
from quant_cache.file_kv_store import FileKeyValueStore

from tests._util.clock import FrozenClock

from .kv_store_contract import KeyValueStoreContract

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock(datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC))


@pytest.fixture
def store(tmp_path: Path, clock: FrozenClock) -> FileKeyValueStore:
    return FileKeyValueStore(root=tmp_path / "kv", clock=clock)


@pytest.mark.contract
class TestFileKeyValueStoreContract(KeyValueStoreContract):
    """All KeyValueStore behaviors must hold for the file backend."""


@pytest.mark.unit
class TestFileKeyValueStoreAdapterSpecific:
    def test_constructor_rejects_non_directory_root(self, tmp_path: Path) -> None:
        not_a_dir = tmp_path / "f.txt"
        not_a_dir.write_text("hi", encoding="utf-8")
        with pytest.raises(CacheBackendUnavailable):
            FileKeyValueStore(root=not_a_dir, clock=FrozenClock(datetime.now(tz=UTC)))

    def test_constructor_creates_root_if_missing(self, tmp_path: Path, clock: FrozenClock) -> None:
        target = tmp_path / "nested" / "kv"
        FileKeyValueStore(root=target, clock=clock)
        assert target.is_dir()

    def test_corrupted_envelope_raises_cache_corrupted(
        self, tmp_path: Path, clock: FrozenClock
    ) -> None:
        store = FileKeyValueStore(root=tmp_path / "kv", clock=clock)
        store.put("k", b"v")
        # Find the on-disk file and trash its contents.
        data_files = [p for p in (tmp_path / "kv").iterdir() if p.suffix == ".json"]
        assert len(data_files) == 1
        data_files[0].write_text("not json {", encoding="utf-8")
        with pytest.raises(CacheCorrupted):
            store.get("k")

    def test_envelope_schema_version_mismatch_raises(
        self, tmp_path: Path, clock: FrozenClock
    ) -> None:
        store = FileKeyValueStore(root=tmp_path / "kv", clock=clock)
        store.put("k", b"v")
        data_files = [p for p in (tmp_path / "kv").iterdir() if p.suffix == ".json"]
        data_files[0].write_text('{"v": 99, "value_b64": "", "expires_at": null}', encoding="utf-8")
        with pytest.raises(CacheCorrupted):
            store.get("k")

    def test_list_prefix_skips_non_envelope_files(self, tmp_path: Path, clock: FrozenClock) -> None:
        store = FileKeyValueStore(root=tmp_path / "kv", clock=clock)
        store.put("real", b"v")
        # Write a stray file that isn't a JSON envelope; list_prefix must skip it.
        (tmp_path / "kv" / "stray.txt").write_text("noise", encoding="utf-8")
        assert list(store.list_prefix("")) == ["real"]
