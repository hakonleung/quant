"""Unit tests for pure pattern primitives (modules/04 §8.1)."""

from __future__ import annotations

import math
from decimal import Decimal

import pytest
from quant_core.domain.pure.pattern import dtw_distance, z_score
from quant_core.errors import QuantError


class TestZScore:
    def test_normalises_typical_series(self) -> None:
        out = z_score([Decimal("1"), Decimal("2"), Decimal("3")])
        # mean=2, std=sqrt(2/3)
        assert out[1] == pytest.approx(0.0)
        assert out[0] == pytest.approx(-out[2])
        assert sum(out) == pytest.approx(0.0)
        assert sum(x * x for x in out) == pytest.approx(len(out))

    def test_constant_series_returns_zeros(self) -> None:
        assert z_score([Decimal("7")] * 5) == [0.0, 0.0, 0.0, 0.0, 0.0]

    def test_single_point(self) -> None:
        assert z_score([Decimal("42")]) == [0.0]

    def test_negative_values(self) -> None:
        out = z_score([Decimal("-1"), Decimal("0"), Decimal("1")])
        assert out[0] < out[1] < out[2]
        assert out[1] == pytest.approx(0.0)

    def test_empty_series_raises(self) -> None:
        with pytest.raises(QuantError) as exc:
            z_score([])
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_decimal_precision_preserved_through_float(self) -> None:
        # Doc says z_score returns floats; precision lost is acceptable
        # as long as ordering invariants hold.
        out = z_score([Decimal("1.0001"), Decimal("1.0002"), Decimal("1.0003")])
        assert out[0] < out[1] < out[2]


class TestDtwDistance:
    def test_identical_sequences_zero(self) -> None:
        s = [1.0, 2.0, 3.0, 4.0]
        assert dtw_distance(s, s) == 0.0

    def test_constant_to_constant_zero(self) -> None:
        assert dtw_distance([5.0] * 4, [5.0] * 4) == 0.0

    def test_known_small_example(self) -> None:
        # Two sequences differing only by a one-step warp.
        a = [0.0, 1.0, 2.0, 3.0]
        b = [0.0, 1.0, 1.0, 2.0, 3.0]
        d_unbanded = dtw_distance(a, b)
        # Optimal alignment can repeat a[1] against b[1],b[2] at zero cost.
        assert d_unbanded == pytest.approx(0.0)

    def test_band_constraint_respected(self) -> None:
        a = [0.0, 0.0, 0.0, 0.0]
        b = [1.0, 1.0, 1.0, 1.0]
        # Same lengths → band only affects path; cost = sqrt(sum 1) = 2.
        assert dtw_distance(a, b, window=0) == pytest.approx(2.0)
        assert dtw_distance(a, b, window=2) == pytest.approx(2.0)

    def test_negative_window_raises(self) -> None:
        with pytest.raises(QuantError) as exc:
            dtw_distance([1.0], [1.0], window=-1)
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_empty_inputs_raise(self) -> None:
        with pytest.raises(QuantError):
            dtw_distance([], [1.0])
        with pytest.raises(QuantError):
            dtw_distance([1.0], [])

    def test_band_too_narrow_for_unequal_lengths_still_aligns(self) -> None:
        # Internally the band auto-grows to abs(n-m); should not raise.
        a = [0.0] * 6
        b = [0.0] * 3
        assert dtw_distance(a, b, window=0) == pytest.approx(0.0)


class TestPropertyInvariance:
    def test_translation_invariance_under_zscore(self) -> None:
        a = [Decimal("1"), Decimal("2"), Decimal("3"), Decimal("5")]
        b = [x + Decimal("100") for x in a]
        za = z_score(a)
        zb = z_score(b)
        assert dtw_distance(za, zb) == pytest.approx(0.0, abs=1e-9)

    def test_scale_invariance_under_zscore(self) -> None:
        a = [Decimal("1"), Decimal("2"), Decimal("3"), Decimal("5")]
        b = [x * Decimal("7") for x in a]
        za = z_score(a)
        zb = z_score(b)
        assert dtw_distance(za, zb) == pytest.approx(0.0, abs=1e-9)


def test_dtw_distance_is_symmetric() -> None:
    a = [0.0, 1.5, 0.5, 2.0]
    b = [0.0, 1.0, 1.0, 2.0]
    assert dtw_distance(a, b) == pytest.approx(dtw_distance(b, a))


def test_dtw_distance_against_pointwise_for_equal_lengths() -> None:
    a = [1.0, 2.0, 3.0]
    b = [1.5, 2.5, 3.5]
    # Strict alignment via window=0 → euclidean distance.
    expected = math.sqrt(0.25 * 3)
    assert dtw_distance(a, b, window=0) == pytest.approx(expected)
