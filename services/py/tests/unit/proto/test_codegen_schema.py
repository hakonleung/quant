"""Validation-path coverage for ``proto/codegen/_schema.py`` and emit helpers."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from proto.codegen import gen_py_errors, gen_ts_errors
from proto.codegen._emit import write_or_check
from proto.codegen._schema import ERRORS_JSON, SchemaError, load_errors

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.unit
class TestLoadErrorsHappyPath:
    def test_canonical_source_loads_and_is_sorted_by_number(self) -> None:
        schema = load_errors()
        numbers = [c.number for c in schema.codes]
        assert numbers == sorted(numbers)
        assert schema.schema_version == 1


_VALID_CODE = {"name": "OK", "number": 0, "http": 200, "description": "ok"}


def _write_errors(path: Path, doc: dict[str, Any]) -> None:
    path.write_text(json.dumps(doc), encoding="utf-8")


@pytest.fixture
def isolated_errors_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "errors.json"
    monkeypatch.setattr("proto.codegen._schema.ERRORS_JSON", target)
    return target


@pytest.mark.unit
class TestLoadErrorsValidation:
    def test_top_level_must_be_object(self, isolated_errors_json: Path) -> None:
        isolated_errors_json.write_text("[]", encoding="utf-8")
        with pytest.raises(SchemaError, match="must be a JSON object"):
            load_errors()

    def test_unsupported_schema_version_rejected(self, isolated_errors_json: Path) -> None:
        _write_errors(isolated_errors_json, {"$schema_version": 2, "codes": []})
        with pytest.raises(SchemaError, match="schema_version"):
            load_errors()

    def test_codes_must_be_list(self, isolated_errors_json: Path) -> None:
        _write_errors(isolated_errors_json, {"$schema_version": 1, "codes": {}})
        with pytest.raises(SchemaError, match="must be a list"):
            load_errors()

    def test_entry_must_be_object(self, isolated_errors_json: Path) -> None:
        _write_errors(isolated_errors_json, {"$schema_version": 1, "codes": ["x"]})
        with pytest.raises(SchemaError, match="entry must be object"):
            load_errors()

    @pytest.mark.parametrize(
        ("override", "match"),
        [
            ({"name": ""}, "bad name"),
            ({"name": "lower_case"}, "UPPER_SNAKE"),
            ({"name": "BAD-NAME!"}, "bad name"),
            ({"number": -1}, "bad number"),
            ({"number": True}, "bad number"),
            ({"http": 50}, "bad http"),
            ({"http": True}, "bad http"),
            ({"description": 123}, "bad description"),
        ],
    )
    def test_field_validation(
        self, isolated_errors_json: Path, override: dict[str, Any], match: str
    ) -> None:
        entry = {**_VALID_CODE, **override}
        _write_errors(isolated_errors_json, {"$schema_version": 1, "codes": [entry]})
        with pytest.raises(SchemaError, match=match):
            load_errors()

    def test_duplicate_name_rejected(self, isolated_errors_json: Path) -> None:
        a = {**_VALID_CODE}
        b = {**_VALID_CODE, "number": 1}
        _write_errors(isolated_errors_json, {"$schema_version": 1, "codes": [a, b]})
        with pytest.raises(SchemaError, match="duplicate name"):
            load_errors()

    def test_duplicate_number_rejected(self, isolated_errors_json: Path) -> None:
        a = {**_VALID_CODE}
        b = {**_VALID_CODE, "name": "OTHER"}
        _write_errors(isolated_errors_json, {"$schema_version": 1, "codes": [a, b]})
        with pytest.raises(SchemaError, match="duplicate number"):
            load_errors()


@pytest.mark.unit
class TestEmitWriteOrCheck:
    def test_check_mode_reports_missing_file(self, tmp_path: Path) -> None:
        target = tmp_path / "out.txt"
        assert write_or_check(target, "x\n", check=True) is False

    def test_check_mode_reports_drift(self, tmp_path: Path) -> None:
        target = tmp_path / "out.txt"
        target.write_text("old\n", encoding="utf-8")
        assert write_or_check(target, "new\n", check=True) is False

    def test_check_mode_passes_when_in_sync(self, tmp_path: Path) -> None:
        target = tmp_path / "out.txt"
        target.write_text("same\n", encoding="utf-8")
        assert write_or_check(target, "same\n", check=True) is True

    def test_write_mode_creates_parents_and_file(self, tmp_path: Path) -> None:
        target = tmp_path / "nested" / "out.txt"
        assert write_or_check(target, "hello\n", check=False) is True
        assert target.read_text(encoding="utf-8") == "hello\n"


@pytest.mark.contract
class TestGeneratedFilesAreInSync:
    """Catches drift between proto/errors.json and the generated modules."""

    def test_python_module_in_sync(self) -> None:
        schema = load_errors()
        assert gen_py_errors.emit(schema, check=True) is True

    def test_typescript_module_in_sync(self) -> None:
        schema = load_errors()
        assert gen_ts_errors.emit(schema, check=True) is True

    def test_python_and_typescript_codes_match(self) -> None:
        # Python side
        from quant_core.contracts.errors import ERROR_CODES, ERROR_NUMBERS

        # JSON side (canonical)
        canonical = json.loads(ERRORS_JSON.read_text(encoding="utf-8"))["codes"]
        canonical_names = {c["name"] for c in canonical}
        canonical_numbers = {c["name"]: c["number"] for c in canonical}

        assert frozenset(canonical_names) == ERROR_CODES
        assert dict(ERROR_NUMBERS) == canonical_numbers
