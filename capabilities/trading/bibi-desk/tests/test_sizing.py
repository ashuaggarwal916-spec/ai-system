"""Unit tests for fractional-Kelly sizing and its clamps."""

from __future__ import annotations

import pytest

from bibi.config import DeskConfig
from bibi.signal import Signal
from bibi.sizing import kelly_size


def _sig(edge: float, sigma: float, side: int = 1) -> Signal:
    alpha = edge / sigma if sigma else 0.0
    return Signal("BTC/USDT", side, edge, sigma, alpha, "test")


def test_flat_signal_sizes_to_zero():
    cfg = DeskConfig()
    res = kelly_size(_sig(0.0, 0.02, side=0), 100_000, 30_000, cfg)
    assert res.is_zero
    assert res.binding_cap == "none"


def test_raw_kelly_formula():
    # edge=0.02, sigma=0.10 -> raw kelly = 0.02 / 0.01 = 2.0, clamped to 1.0.
    # max_positions=1 makes the slot cap (=1.0) non-binding so we isolate Kelly.
    cfg = DeskConfig(kelly_fraction=1.0, max_positions=1, risk_per_trade_R=10.0)
    res = kelly_size(_sig(0.02, 0.10), 100_000, 30_000, cfg)
    assert res.raw_kelly == pytest.approx(1.0)  # clamped at _MAX_RAW_KELLY


def test_fractional_kelly_scales_down():
    # small edge keeps raw kelly < 1 so the fraction multiplier is visible;
    # slot cap (1/1 = 1.0) and risk_R (no stop passed) are non-binding here.
    cfg_full = DeskConfig(kelly_fraction=1.0, max_positions=1, risk_per_trade_R=10.0)
    cfg_quarter = DeskConfig(kelly_fraction=0.25, max_positions=1, risk_per_trade_R=10.0)
    full = kelly_size(_sig(0.004, 0.10), 100_000, 30_000, cfg_full)
    quarter = kelly_size(_sig(0.004, 0.10), 100_000, 30_000, cfg_quarter)
    assert full.kelly_fraction == pytest.approx(0.4)        # 0.004 / 0.10**2
    assert quarter.kelly_fraction == pytest.approx(0.25 * full.kelly_fraction)


def test_risk_R_cap_binds():
    # tight stop + a big kelly -> per-trade R cap should bind. Keep the slot cap
    # loose (max_positions=1 -> 1.0) so the R cap is the binding constraint.
    cfg = DeskConfig(kelly_fraction=1.0, risk_per_trade_R=0.01, max_positions=1)
    res = kelly_size(_sig(0.05, 0.05), 100_000, 30_000, cfg,
                     stop_distance_frac=0.02)
    # r_cap_frac = 0.01 / 0.02 = 0.5
    assert res.binding_cap == "risk_R"
    assert res.kelly_fraction == pytest.approx(0.5)


def test_slot_cap_binds():
    cfg = DeskConfig(kelly_fraction=1.0, max_positions=4, risk_per_trade_R=10.0)
    res = kelly_size(_sig(0.05, 0.05), 100_000, 30_000, cfg)
    # slot cap = 1/4 = 0.25, which is below the kelly fraction here
    assert res.binding_cap == "slots"
    assert res.kelly_fraction == pytest.approx(0.25)


def test_no_slots_left():
    cfg = DeskConfig(max_positions=2)
    res = kelly_size(_sig(0.05, 0.05), 100_000, 30_000, cfg, open_positions=2)
    assert res.is_zero
    assert res.binding_cap == "slots"


def test_notional_and_quantity_consistent():
    cfg = DeskConfig(kelly_fraction=0.25, max_positions=10, risk_per_trade_R=10.0)
    price = 25_000.0
    res = kelly_size(_sig(0.01, 0.08), 100_000, price, cfg)
    assert res.quantity == pytest.approx(res.notional / price)
    assert 0.0 <= res.kelly_fraction <= 1.0
