"""Contract test — generated error code module is internally consistent.

Cross-language drift between this module and the TS equivalent is prevented
by ``pnpm gen:proto:check`` (CI gate); these tests focus on internal
invariants the generator must maintain.
"""

from __future__ import annotations

import pytest
from quant_core.contracts.errors import ERROR_CODES, ERROR_HTTP_STATUS, ERROR_NUMBERS


@pytest.mark.contract
class TestGeneratedErrorCodes:
    def test_every_code_has_number_and_http(self) -> None:
        for code in ERROR_CODES:
            assert code in ERROR_NUMBERS, f"{code} missing number"
            assert code in ERROR_HTTP_STATUS, f"{code} missing http"

    def test_numbers_are_unique(self) -> None:
        numbers = list(ERROR_NUMBERS.values())
        assert len(set(numbers)) == len(numbers), "duplicate ErrorCode numbers"

    def test_http_status_in_range(self) -> None:
        for code, status in ERROR_HTTP_STATUS.items():
            assert 100 <= status <= 599, f"{code} http={status} out of range"

    def test_internal_sentinel_present(self) -> None:
        # Catch-all required by docs/integrations/ipc-py-ts.md §4.
        assert "INTERNAL" in ERROR_CODES
        assert "OK" in ERROR_CODES

    def test_codes_set_matches_number_keys(self) -> None:
        # ERROR_CODES is the source of truth; the maps must agree.
        assert frozenset(ERROR_NUMBERS.keys()) == ERROR_CODES
        assert frozenset(ERROR_HTTP_STATUS.keys()) == ERROR_CODES
