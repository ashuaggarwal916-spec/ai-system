"""Unit tests for the backtest metrics math."""

from __future__ import annotations

import math

import numpy as np
import pytest

from backtest.metrics import (
    cagr,
    compute_metrics,
    expectancy_R,
    hit_rate,
    max_drawdown,
    profit_factor,
    returns_from_equity,
    sharpe_ratio,
    sortino_ratio,
)


def test_returns_from_equity_basic():
    eq = [100.0, 110.0, 99.0]
    rets = returns_from_equity(eq)
    assert rets == pytest.approx([0.1, -0.1])


def test_max_drawdown_known_curve():
    # peak 120 then trough 90 -> 25% drawdown
    eq = [100, 120, 90, 100]
    assert max_drawdown(eq) == pytest.approx(0.25)


def test_max_drawdown_monotonic_is_zero():
    assert max_drawdown([100, 101, 102, 110]) == 0.0


def test_sharpe_zero_vol_is_zero():
    # constant returns -> zero std -> guarded to 0.0
    assert sharpe_ratio(np.array([0.01, 0.01, 0.01]), ppy=8760.0) == 0.0


def test_sharpe_sign_follows_mean():
    up = sharpe_ratio(np.array([0.01, 0.02, -0.005, 0.015]), ppy=252.0)
    down = sharpe_ratio(np.array([-0.01, -0.02, 0.005, -0.015]), ppy=252.0)
    assert up > 0 > down


def test_sortino_only_penalises_downside():
    # all-positive excess returns -> infinite (no downside deviation)
    rets = np.array([0.01, 0.02, 0.015])
    assert math.isinf(sortino_ratio(rets, ppy=252.0))


def test_profit_factor_and_hit_rate():
    trade_R = [2.0, -1.0, 2.0, -1.0, 3.0]
    # gross gain 7, gross loss 2 -> PF 3.5 ; 3/5 winners
    assert profit_factor(trade_R) == pytest.approx(3.5)
    assert hit_rate(trade_R) == pytest.approx(0.6)


def test_expectancy_R():
    assert expectancy_R([2.0, -1.0, 2.0, -1.0]) == pytest.approx(0.5)


def test_cagr_doubling_over_one_year():
    # 8760 hourly steps == 1 year; equity doubles -> 100% CAGR
    eq = list(np.linspace(100.0, 200.0, 8761))
    assert cagr(eq, ppy=8760.0) == pytest.approx(1.0, rel=1e-3)


def test_compute_metrics_smoke():
    rng = np.random.default_rng(0)
    eq = list(100_000.0 * np.cumprod(1 + rng.normal(0.0002, 0.01, 500)))
    report = compute_metrics(eq, [1.0, -0.5, 2.0], [True] * 250 + [False] * 250,
                             timeframe="1h")
    assert report.n_trades == 3
    assert 0.0 <= report.exposure <= 1.0
    assert report.profit_factor > 0
    assert "Sharpe" in report.as_table()
