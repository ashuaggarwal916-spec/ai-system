"""Bibi - an AI crypto-trading desk powered by the Kronos candlestick model.

Bibi is a compact, opinionated research desk that wraps the open-source
`Kronos <https://github.com/shiyu-coder/Kronos>`_ foundation model for
financial candlesticks. The pipeline is intentionally linear and easy to
audit:

    candles -> forecast -> signal -> sizing -> risk -> execution

Each stage lives in its own module and exchanges small, well-typed value
objects (:class:`~bibi.engine.Forecast`, :class:`~bibi.signal.Signal`,
:class:`~bibi.execution.Position`, :class:`~bibi.execution.Fill`). The
:class:`~bibi.desk.Desk` glues the stages together and is the intended entry
point for live/paper trading; the :mod:`backtest` package replays the same
logic over historical bars.
"""

from __future__ import annotations

from bibi.config import DeskConfig
from bibi.data import CandleFeed
from bibi.engine import Forecast, KronosForecaster
from bibi.signal import Signal, build_signal, ensemble_vote
from bibi.sizing import SizingResult, kelly_size
from bibi.risk import Position as RiskPosition, RiskManager
from bibi.execution import Execution, Fill, PaperBroker, Position
from bibi.desk import Decision, Desk

__all__ = [
    "DeskConfig",
    "CandleFeed",
    "Forecast",
    "KronosForecaster",
    "Signal",
    "build_signal",
    "ensemble_vote",
    "SizingResult",
    "kelly_size",
    "RiskManager",
    "RiskPosition",
    "Execution",
    "Fill",
    "PaperBroker",
    "Position",
    "Decision",
    "Desk",
]

__version__ = "0.3.0"
