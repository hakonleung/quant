"""Abstract contract test for any :class:`RecordRepo` adapter.

Backends parameterise on a sample record type ``Person`` so the contract
covers realistic CRUD + query semantics without coupling to one schema.
Concrete adapter test modules subclass :class:`RecordRepoContract` in a
``Test*`` class and provide a ``repo`` fixture; see
``test_parquet_record_repo.py``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import pytest
from quant_core.domain.types.query import (
    MATCH_ALL,
    And,
    Eq,
    In,
    Like,
    Or,
    QuerySpec,
    Range,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.ports.cache import RecordRepo


@dataclass(frozen=True, slots=True)
class Person:
    """Sample record type used by the contract."""

    id: str
    name: str
    age: int
    city: str


def person_to_row(p: Person) -> Mapping[str, object]:
    return {"id": p.id, "name": p.name, "age": p.age, "city": p.city}


def person_from_row(row: Mapping[str, object]) -> Person:
    age = row["age"]
    assert isinstance(age, int)
    return Person(
        id=str(row["id"]),
        name=str(row["name"]),
        age=age,
        city=str(row["city"]),
    )


def person_key(p: Person) -> str:
    return p.id


SEED_PEOPLE: tuple[Person, ...] = (
    Person("p1", "Alice", 30, "Beijing"),
    Person("p2", "Bob", 25, "Shanghai"),
    Person("p3", "Charlie", 35, "Beijing"),
    Person("p4", "Diana", 28, "Shenzhen"),
    Person("p5", "Eve", 40, "Shanghai"),
)


class RecordRepoContract:
    """Behavior guaranteed by every :class:`RecordRepo` implementation."""

    # -- get / upsert / delete ------------------------------------------

    def test_get_missing_returns_none(self, repo: RecordRepo[Person]) -> None:
        assert repo.get("nope") is None

    def test_upsert_then_get(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many([SEED_PEOPLE[0]])
        assert repo.get("p1") == SEED_PEOPLE[0]

    def test_upsert_overwrites_existing_key(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many([SEED_PEOPLE[0]])
        updated = Person("p1", "Alice", 31, "Beijing")
        repo.upsert_many([updated])
        assert repo.get("p1") == updated

    def test_upsert_empty_iterable_is_noop(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many([])
        assert repo.get("p1") is None

    def test_delete_is_idempotent_on_missing(self, repo: RecordRepo[Person]) -> None:
        repo.delete("ghost")
        repo.delete("ghost")  # second call must not raise

    def test_delete_removes_record(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many([SEED_PEOPLE[0]])
        repo.delete("p1")
        assert repo.get("p1") is None

    def test_delete_leaves_other_records(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        repo.delete("p1")
        assert repo.get("p1") is None
        assert repo.get("p2") == SEED_PEOPLE[1]

    # -- query: predicates ----------------------------------------------

    def test_query_match_all_returns_all(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        assert sorted(repo.query(MATCH_ALL), key=person_key) == sorted(SEED_PEOPLE, key=person_key)

    def test_query_eq(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        assert sorted(repo.query(QuerySpec(where=Eq("city", "Beijing"))), key=person_key) == [
            SEED_PEOPLE[0],
            SEED_PEOPLE[2],
        ]

    def test_query_in(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = sorted(
            repo.query(QuerySpec(where=In("city", ("Beijing", "Shenzhen")))),
            key=person_key,
        )
        assert result == [SEED_PEOPLE[0], SEED_PEOPLE[2], SEED_PEOPLE[3]]

    def test_query_in_empty_matches_nothing(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        assert list(repo.query(QuerySpec(where=In("city", ())))) == []

    def test_query_range_inclusive(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = sorted(repo.query(QuerySpec(where=Range("age", 28, 35))), key=person_key)
        assert [p.id for p in result] == ["p1", "p3", "p4"]

    def test_query_range_unbounded_low(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = sorted(repo.query(QuerySpec(where=Range("age", None, 28))), key=person_key)
        assert [p.id for p in result] == ["p2", "p4"]

    def test_query_range_unbounded_high(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = sorted(repo.query(QuerySpec(where=Range("age", 35, None))), key=person_key)
        assert [p.id for p in result] == ["p3", "p5"]

    def test_query_like(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = sorted(repo.query(QuerySpec(where=Like("name", "A%"))), key=person_key)
        assert [p.id for p in result] == ["p1"]

    def test_query_like_underscore(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        # "B__" matches names of length 3 starting with B → "Bob"
        result = sorted(repo.query(QuerySpec(where=Like("name", "B__"))), key=person_key)
        assert [p.id for p in result] == ["p2"]

    def test_query_and(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        spec = QuerySpec(where=And((Eq("city", "Beijing"), Range("age", 32, None))))
        assert [p.id for p in repo.query(spec)] == ["p3"]

    def test_query_or(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        spec = QuerySpec(where=Or((Eq("city", "Shenzhen"), Eq("name", "Eve"))))
        result = sorted(repo.query(spec), key=person_key)
        assert [p.id for p in result] == ["p4", "p5"]

    def test_query_and_empty_is_true(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        assert sorted(repo.query(QuerySpec(where=And(()))), key=person_key) == sorted(
            SEED_PEOPLE, key=person_key
        )

    def test_query_or_empty_is_false(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        assert list(repo.query(QuerySpec(where=Or(())))) == []

    # -- query: order_by + limit ----------------------------------------

    def test_query_order_by_asc(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = list(repo.query(QuerySpec(order_by=(("age", "asc"),))))
        assert [p.age for p in result] == [25, 28, 30, 35, 40]

    def test_query_order_by_desc(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = list(repo.query(QuerySpec(order_by=(("age", "desc"),))))
        assert [p.age for p in result] == [40, 35, 30, 28, 25]

    def test_query_order_by_multiple(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = list(repo.query(QuerySpec(order_by=(("city", "asc"), ("age", "desc")))))
        assert [p.id for p in result] == ["p3", "p1", "p5", "p2", "p4"]

    def test_query_limit(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        result = list(repo.query(QuerySpec(order_by=(("age", "asc"),), limit=2)))
        assert [p.id for p in result] == ["p2", "p4"]

    def test_query_filter_then_order_then_limit(self, repo: RecordRepo[Person]) -> None:
        repo.upsert_many(SEED_PEOPLE)
        spec = QuerySpec(
            where=Eq("city", "Beijing"),
            order_by=(("age", "desc"),),
            limit=1,
        )
        result = list(repo.query(spec))
        assert [p.id for p in result] == ["p3"]

    def test_query_on_empty_repo(self, repo: RecordRepo[Person]) -> None:
        assert list(repo.query(MATCH_ALL)) == []
        assert list(repo.query(QuerySpec(where=Eq("city", "Beijing")))) == []

    def test_query_unknown_field_raises(self, repo: RecordRepo[Person]) -> None:
        from quant_cache.errors import CacheBackendUnavailable

        repo.upsert_many(SEED_PEOPLE)
        with pytest.raises(CacheBackendUnavailable):
            list(repo.query(QuerySpec(where=Eq("nope", 1))))
