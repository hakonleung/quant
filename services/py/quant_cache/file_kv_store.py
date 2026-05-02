"""Filesystem-backed :class:`KeyValueStore` adapter (cache-abstraction.md §4).

One file per key (``urlsafe_b64`` encoded name). Atomic ``put`` via
``os.replace`` on a sibling ``.tmp`` file; per-key concurrency guarded by
``filelock.FileLock``. Optional TTL is enforced lazily on read using the
injected :class:`Clock`.

Why a JSON envelope:
    - ``value`` is opaque ``bytes``; we round-trip it through ``base64``
      because JSON has no native binary type and ``bytes`` is what the
      ``KeyValueStore`` port promises callers.
    - ``expires_at`` rides alongside the value so TTL survives process
      restarts without an external clock-state store.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import tempfile
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

from filelock import FileLock, Timeout

from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

    from quant_core.ports.clock import Clock

_ENVELOPE_VERSION: Final[int] = 1
_DEFAULT_LOCK_TIMEOUT: Final[float] = 5.0


def _encode_key(key: str) -> str:
    return base64.urlsafe_b64encode(key.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_key(filename: str) -> str:
    pad = "=" * (-len(filename) % 4)
    return base64.urlsafe_b64decode((filename + pad).encode("ascii")).decode("utf-8")


class FileKeyValueStore:
    """Per-key JSON-on-disk implementation of :class:`KeyValueStore`.

    Args:
        root: Directory to store files under. Created on first use.
        clock: Time source for TTL evaluation.
        lock_timeout_sec: How long to wait for a per-key lock before failing.

    Raises:
        CacheBackendUnavailable: if ``root`` exists but is not a directory.
    """

    __slots__ = ("_clock", "_lock_timeout", "_root")

    def __init__(
        self,
        root: Path,
        clock: Clock,
        *,
        lock_timeout_sec: float = _DEFAULT_LOCK_TIMEOUT,
    ) -> None:
        if root.exists() and not root.is_dir():
            raise CacheBackendUnavailable(
                f"FileKeyValueStore root is not a directory: {root}",
                {"root": str(root)},
            )
        root.mkdir(parents=True, exist_ok=True)
        self._root = root
        self._clock = clock
        self._lock_timeout = lock_timeout_sec

    # -- internal helpers ------------------------------------------------

    def _path_for(self, key: str) -> Path:
        return self._root / f"{_encode_key(key)}.json"

    def _lock_for(self, key: str) -> FileLock:
        return FileLock(str(self._path_for(key)) + ".lock", timeout=self._lock_timeout)

    def _read_envelope(self, path: Path) -> tuple[bytes, datetime | None]:
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to read cache file: {path}", {"path": str(path)}
            ) from exc
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CacheCorrupted(
                f"cache envelope is not valid JSON: {path}", {"path": str(path)}
            ) from exc
        if not isinstance(doc, dict) or doc.get("v") != _ENVELOPE_VERSION:
            raise CacheCorrupted(
                f"cache envelope schema mismatch: {path}",
                {"path": str(path), "v": doc.get("v") if isinstance(doc, dict) else None},
            )
        value_b64 = doc.get("value_b64")
        expires_raw = doc.get("expires_at")
        if not isinstance(value_b64, str):
            raise CacheCorrupted(f"cache envelope missing value_b64: {path}", {"path": str(path)})
        try:
            value = base64.b64decode(value_b64.encode("ascii"), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise CacheCorrupted(
                f"cache envelope value_b64 not decodable: {path}", {"path": str(path)}
            ) from exc
        expires_at: datetime | None
        if expires_raw is None:
            expires_at = None
        elif isinstance(expires_raw, str):
            try:
                expires_at = datetime.fromisoformat(expires_raw)
            except ValueError as exc:
                raise CacheCorrupted(
                    f"cache envelope bad expires_at: {path}",
                    {"path": str(path), "expires_at": expires_raw},
                ) from exc
            if expires_at.tzinfo is None:
                raise CacheCorrupted(
                    f"cache envelope expires_at is naive: {path}",
                    {"path": str(path), "expires_at": expires_raw},
                )
        else:
            raise CacheCorrupted(
                f"cache envelope bad expires_at type: {path}",
                {"path": str(path), "expires_at": expires_raw},
            )
        return value, expires_at

    def _write_envelope(self, path: Path, value: bytes, expires_at: datetime | None) -> None:
        envelope = {
            "v": _ENVELOPE_VERSION,
            "value_b64": base64.b64encode(value).decode("ascii"),
            "expires_at": expires_at.isoformat() if expires_at is not None else None,
        }
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._root,
                prefix=path.name + ".",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                json.dump(envelope, tmp, separators=(",", ":"))
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_path = tmp.name
            os.replace(tmp_path, path)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to write cache file: {path}", {"path": str(path)}
            ) from exc

    # -- KeyValueStore protocol -----------------------------------------

    def get(self, key: str) -> bytes | None:
        path = self._path_for(key)
        if not path.exists():
            return None
        value, expires_at = self._read_envelope(path)
        if expires_at is not None and self._clock.now() >= expires_at:
            self.delete(key)
            return None
        return value

    def put(self, key: str, value: bytes, *, ttl_sec: int | None = None) -> None:
        if ttl_sec is not None and ttl_sec <= 0:
            raise CacheBackendUnavailable(
                "ttl_sec must be a positive integer or None",
                {"ttl_sec": ttl_sec},
            )
        from datetime import timedelta

        expires_at = (
            self._clock.now().astimezone(UTC) + timedelta(seconds=ttl_sec)
            if ttl_sec is not None
            else None
        )
        path = self._path_for(key)
        try:
            with self._lock_for(key):
                self._write_envelope(path, value, expires_at)
        except Timeout as exc:
            raise CacheBackendUnavailable(
                f"timed out acquiring lock for key: {key}",
                {"key": key, "timeout_sec": self._lock_timeout},
            ) from exc

    def delete(self, key: str) -> None:
        path = self._path_for(key)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to delete cache file: {path}", {"path": str(path)}
            ) from exc

    def list_prefix(self, prefix: str) -> Iterable[str]:
        try:
            entries = sorted(self._root.iterdir())
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to list cache root: {self._root}", {"root": str(self._root)}
            ) from exc
        for entry in entries:
            if not entry.is_file() or entry.suffix != ".json":
                continue
            try:
                key = _decode_key(entry.stem)
            except (binascii.Error, ValueError, UnicodeDecodeError):
                continue
            if key.startswith(prefix):
                yield key
