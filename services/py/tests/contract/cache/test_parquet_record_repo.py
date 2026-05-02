"""ParquetRecordRepo: contract conformance + adapter-specific edge cases."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted
from quant_cache.parquet_record_repo import Codec, ParquetRecordRepo

from tests.contract.cache.record_repo_contract import (
    SEED_PEOPLE,
    Person,
    RecordRepoContract,
    person_from_row,
    person_key,
    person_to_row,
)

if TYPE_CHECKING:
    from pathlib import Path


PERSON_SCHEMA = pa.schema(
    [
        ("id", pa.string()),
        ("name", pa.string()),
        ("age", pa.int64()),
        ("city", pa.string()),
    ]
)

PERSON_CODEC: Codec[Person] = Codec(
    to_row=person_to_row,
    from_row=person_from_row,
    key_of=person_key,
)


@pytest.fixture
def repo(tmp_path: Path) -> ParquetRecordRepo[Person]:
    return ParquetRecordRepo(
        tmp_path / "people.parquet",
        schema=PERSON_SCHEMA,
        key_field="id",
        codec=PERSON_CODEC,
    )


class TestParquetRecordRepoContract(RecordRepoContract):
    """Run the full RecordRepo contract against the parquet adapter."""


@pytest.mark.unit
class TestParquetRecordRepoAdapterSpecific:
    def test_constructor_rejects_unknown_key_field(self, tmp_path: Path) -> None:
        with pytest.raises(CacheBackendUnavailable):
            ParquetRecordRepo(
                tmp_path / "x.parquet",
                schema=PERSON_SCHEMA,
                key_field="missing",
                codec=PERSON_CODEC,
            )

    def test_corrupted_file_raises_cache_corrupted(self, tmp_path: Path) -> None:
        path = tmp_path / "people.parquet"
        path.write_bytes(b"not a parquet file")
        repo = ParquetRecordRepo(path, schema=PERSON_SCHEMA, key_field="id", codec=PERSON_CODEC)
        with pytest.raises(CacheCorrupted):
            repo.get("p1")

    def test_schema_mismatch_raises_cache_corrupted(self, tmp_path: Path) -> None:
        path = tmp_path / "people.parquet"
        wrong_schema = pa.schema([("id", pa.string()), ("extra", pa.int64())])
        pq.write_table(
            pa.Table.from_pylist([{"id": "p1", "extra": 1}], schema=wrong_schema),
            path,
        )
        repo = ParquetRecordRepo(path, schema=PERSON_SCHEMA, key_field="id", codec=PERSON_CODEC)
        with pytest.raises(CacheCorrupted):
            repo.get("p1")

    def test_persists_across_repo_instances(self, tmp_path: Path) -> None:
        path = tmp_path / "people.parquet"
        repo_a = ParquetRecordRepo(path, schema=PERSON_SCHEMA, key_field="id", codec=PERSON_CODEC)
        repo_a.upsert_many(SEED_PEOPLE)

        repo_b = ParquetRecordRepo(path, schema=PERSON_SCHEMA, key_field="id", codec=PERSON_CODEC)
        assert repo_b.get("p3") == SEED_PEOPLE[2]

    def test_upsert_with_bad_row_dict_raises_backend_unavailable(self, tmp_path: Path) -> None:
        # Codec returns a row missing the schema's `age` column.
        bad_codec: Codec[Person] = Codec(
            to_row=lambda p: {"id": p.id, "name": p.name, "city": p.city},
            from_row=person_from_row,
            key_of=person_key,
        )
        repo = ParquetRecordRepo(
            tmp_path / "p.parquet",
            schema=PERSON_SCHEMA,
            key_field="id",
            codec=bad_codec,
        )
        with pytest.raises(CacheBackendUnavailable):
            repo.upsert_many([SEED_PEOPLE[0]])
