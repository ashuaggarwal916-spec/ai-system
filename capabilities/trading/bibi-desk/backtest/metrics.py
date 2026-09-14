"""Performance metrics for an equity curve and a trades blotter.

All formulas are standard and documented inline. Returns are simple
(arithmetic) per-period returns of the equity curve unless noted. Annualisation
uses ``periods_per_year`` derived from the trading timeframe (e.g. 24*365 for
hourly bars on a 24/7 crypto market).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Optional, Sequence

import numpy as np
import pandas as pd

# Bars per year for common crypto (24/7) timeframes.
PERIODS_PER_YEAR: Dict[str, float] = {
    "1m": 525_600.0, "5m": 105_120.0, "15m": 35_040.0, "30m": 17_520.0,
    "1h": 8_760.0, "2h": 4_380.0, "4h": 2_190.0, "12h": 730.0, "1d": 365.0,
}


def periods_per_year(timeframe: str) -> float:
    """Number of bars per year for a 24/7 market on ``timeframe``."""
    return PERIODS_PER_YEAR.get(timeframe, 252.0)


@dataclass
class PerformanceReport:
    """Container for the full set of performance statistics."""

    sharpe: float
    sortino: float
    cagr: float
    max_drawdown: float
    hit_rate: float
    profit_factor: float
    expectancy_R: float
    exposure: float
    n_trades: int
    total_return: float

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)

    def as_table(self) -> str:
        """Pretty fixed-width table for CLI output."""
        rows = [
            ("Total return", f"{self.total_return:+.2%}"),
            ("CAGR", f"{self.cagr:+.2%}"),
            ("Sharpe (ann.)", f"{self.sharpe:.2f}"),
            ("Sortino (ann.)", f"{self.sortino:.2f}"),
            ("Max drawdown", f"{self.max_drawdown:.2%}"),
            ("Hit rate", f"{self.hit_rate:.2%}"),
            ("Profit factor", f"{self.profit_factor:.2f}"),
            ("Expectancy (R)", f"{self.expectancy_R:+.3f}"),
            ("Exposure", f"{self.exposure:.2%}"),
            ("Trades", f"{self.n_trades:d}"),
        ]
        width = max(len(k) for k, _ in rows)
        lines = ["  " + k.ljust(width) + "   " + v for k, v in rows]
        return "\n".join(lines)


# --------------------------------------------------------------------- helpers
def returns_from_equity(equity: Sequence[float]) -> np.ndarray:
    """Simple per-period returns of an equity curve."""
    eq = np.asarray(equity, dtype=float)
    if len(eq) < 2:
        return np.array([])
    return eq[1:] / eq[:-1] - 1.0


def sharpe_ratio(returns: np.ndarray, ppy: float, rf: float = 0.0) -> float:
    """Annualised Sharpe ratio.

    ``Sharpe = sqrt(ppy) * mean(excess) / std(excess)`` where ``excess`` is the
    per-period return minus the per-period risk-free rate.
    """
    if len(returns) < 2:
        return 0.0
    excess = returns - rf / ppy
    sd = np.std(excess, ddof=1)
    if sd < 1e-12:
        return 0.0
    return float(np.sqrt(ppy) * np.mean(excess) / sd)


def sortino_ratio(returns: np.ndarray, ppy: float, rf: float = 0.0) -> float:
    """Annualised Sortino ratio (downside-deviation denominator).

    Only negative excess returns enter the denominator, rewarding strategies
    whose volatility is mostly to the upside.
    """
    if len(returns) < 2:
        return 0.0
    excess = returns - rf / ppy
    downside = excess[excess < 0.0]
    if len(downside) == 0:
        return float("inf") if np.mean(excess) > 0 else 0.0
    dd = np.sqrt(np.mean(np.square(downside)))
    if dd < 1e-12:
        return 0.0
    return float(np.sqrt(ppy) * np.mean(excess) / dd)


def max_drawdown(equity: Sequence[float]) -> float:
    """Maximum peak-to-trough drawdown as a positive fraction."""
    eq = np.asarray(equity, dtype=float)
    if len(eq) == 0:
        return 0.0
    running_max = np.maximum.accumulate(eq)
    drawdowns = 1.0 - eq / running_max
    return float(np.max(drawdowns))


def cagr(equity: Sequence[float], ppy: float) -> float:
    """Compound annual growth rate implied by the equity curve length."""
    eq = np.asarray(equity, dtype=float)
    if len(eq) < 2 or eq[0] <= 0 or eq[-1] <= 0:
        return 0.0
    years = (len(eq) - 1) / ppy
    if years <= 0:
        return 0.0
    return float((eq[-1] / eq[0]) ** (1.0 / years) - 1.0)


def hit_rate(trade_R: Sequence[float]) -> float:
    """Fraction of closed trades with positive R."""
    arr = np.asarray(trade_R, dtype=float)
    return float(np.mean(arr > 0.0)) if len(arr) else 0.0


def profit_factor(trade_R: Sequence[float]) -> float:
    """Gross profit / gross loss across closed trades (in R)."""
    arr = np.asarray(trade_R, dtype=float)
    gains = arr[arr > 0].sum()
    losses = -arr[arr < 0].sum()
    if losses < 1e-12:
        return float("inf") if gains > 0 else 0.0
    return float(gains / losses)


def expectancy_R(trade_R: Sequence[float]) -> float:
    """Average R per trade (the expectancy of the edge)."""
    arr = np.asarray(trade_R, dtype=float)
    return float(np.mean(arr)) if len(arr) else 0.0


def exposure(in_market_flags: Sequence[bool]) -> float:
    """Fraction of bars during which at least one position was open."""
    arr = np.asarray(in_market_flags, dtype=bool)
    return float(np.mean(arr)) if len(arr) else 0.0


def compute_metrics(
    equity_curve: Sequence[float],
    trade_R: Sequence[float],
    in_market_flags: Optional[Sequence[bool]] = None,
    timeframe: str = "1h",
    rf: float = 0.0,
) -> PerformanceReport:
    """Assemble a full :class:`PerformanceReport` from the run outputs.

    Parameters
    ----------
    equity_curve:
        Mark-to-market equity sampled once per bar.
    trade_R:
        Realised R-multiple for each *closed* trade.
    in_market_flags:
        Per-bar booleans for exposure; defaults to all-False if omitted.
    timeframe:
        Bar timeframe for annualisation.
    rf:
        Annual risk-free rate.
    """
    ppy = periods_per_year(timeframe)
    rets = returns_from_equity(equity_curve)
    eq = np.asarray(equity_curve, dtype=float)
    total = float(eq[-1] / eq[0] - 1.0) if len(eq) >= 2 and eq[0] > 0 else 0.0

    return PerformanceReport(
        sharpe=sharpe_ratio(rets, ppy, rf),
        sortino=sortino_ratio(rets, ppy, rf),
        cagr=cagr(eq, ppy),
        max_drawdown=max_drawdown(eq),
        hit_rate=hit_rate(trade_R),
        profit_factor=profit_factor(trade_R),
        expectancy_R=expectancy_R(trade_R),
        exposure=exposure(in_market_flags or []),
        n_trades=len(trade_R),
        total_return=total,
    )
