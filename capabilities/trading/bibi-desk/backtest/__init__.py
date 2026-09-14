"""Backtesting for the Bibi desk.

The backtester replays the *same* signal and sizing logic the live desk uses
over historical (or synthetic) bars, so research and production never diverge.
:mod:`backtest.metrics` implements the standard performance statistics and
:mod:`backtest.backtester` walks the bars and produces an equity curve plus a
trades blotter.
"""

from __future__ import annotations

from backtest.metrics import PerformanceReport, compute_metrics
from backtest.backtester import BacktestResult, Backtester

__all__ = [
    "PerformanceReport",
    "compute_metrics",
    "BacktestResult",
    "Backtester",
]
