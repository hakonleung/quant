"""Abstract contract test for any :class:`KeyValueStore` adapter.

Every backend (file, redis, ...) must subclass :class:`KeyValueStoreContract`
in a ``Test*`` class and provide ``store`` + ``clock`` fixtures (see
``test_file_kv_store.py`` for an example). The base class deliberately has
no ``Test`` prefix so pytest does not collect it on its own.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_cache.errors import CacheBackendUnavailable

if TYPE_CHECKING:
    from quant_core.ports.cache import KeyValueStore

    from tests._util.clock import FrozenClock


class KeyValueStoreContract:
    """Behavior guaranteed by every :class:`KeyValueStore` implementation."""

    def test_put_then_get_returns_stored_bytes(self, store: KeyValueStore) -> None:
        store.put("alpha", b"hello")
        assert store.get("alpha") == b"hello"

    def test_get_missing_key_returns_none(self, store: KeyValueStore) -> None:
        assert store.get("never-set") is None

    def test_put_overwrites_previous_value(self, store: KeyValueStore) -> None:
        store.put("k", b"first")
        store.put("k", b"second")
        assert store.get("k") == b"second"

    def test_delete_is_idempotent_on_missing_key(self, store: KeyValueStore) -> None:
        store.delete("ghost")
        store.delete("ghost")  # second call must not raise

    def test_delete_removes_value(self, store: KeyValueStore) -> None:
        store.put("k", b"v")
        store.delete("k")
        assert store.get("k") is None

    def test_empty_value_round_trips(self, store: KeyValueStore) -> None:
        store.put("empty", b"")
        assert store.get("empty") == b""

    @pytest.mark.parametrize(
        "key",
        ["with/slash", "中文键", "with space", "with:colon", "a" * 80],
        ids=["slash", "unicode", "space", "colon", "long-80"],
    )
    def test_round_trip_with_special_keys(self, store: KeyValueStore, key: str) -> None:
        store.put(key, b"v")
        assert store.get(key) == b"v"

    def test_large_value_round_trips(self, store: KeyValueStore) -> None:
        big = b"x" * (256 * 1024)  # 256 KiB
        store.put("big", big)
        assert store.get("big") == big

    def test_list_prefix_returns_only_matching_keys_sorted(self, store: KeyValueStore) -> None:
        for key in ("user:b", "user:a", "task:1", "user:c"):
            store.put(key, b"v")
        assert list(store.list_prefix("user:")) == ["user:a", "user:b", "user:c"]
        assert list(store.list_prefix("task:")) == ["task:1"]
        assert list(store.list_prefix("zzz")) == []

    def test_list_prefix_empty_string_returns_all_keys(self, store: KeyValueStore) -> None:
        for key in ("a", "b"):
            store.put(key, b"v")
        assert sorted(store.list_prefix("")) == ["a", "b"]

    def test_ttl_expired_key_returns_none_and_evicts(
        self, store: KeyValueStore, clock: FrozenClock
    ) -> None:
        store.put("ephemeral", b"v", ttl_sec=10)
        assert store.get("ephemeral") == b"v"
        clock.advance(seconds=11)
        assert store.get("ephemeral") is None
        # eviction must remove the underlying file too
        assert list(store.list_prefix("ephemeral")) == []

    def test_ttl_not_yet_expired_returns_value(
        self, store: KeyValueStore, clock: FrozenClock
    ) -> None:
        store.put("ephemeral", b"v", ttl_sec=60)
        clock.advance(seconds=30)
        assert store.get("ephemeral") == b"v"

    @pytest.mark.parametrize("bad_ttl", [0, -1, -10])
    def test_put_rejects_non_positive_ttl(self, store: KeyValueStore, bad_ttl: int) -> None:
        with pytest.raises(CacheBackendUnavailable):
            store.put("k", b"v", ttl_sec=bad_ttl)
