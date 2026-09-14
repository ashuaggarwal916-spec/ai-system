"""Event-driven backtester.

The backtester walks historical bars one at a time and, at each step, hands the
trailing window to the desk's own signal + sizing + risk logic - so the code
path under test is identical to live. Forecasts come from a pluggable
``forecast_fn`` (the same hook the :class:`~bibi.desk.Desk` accepts), which lets
the backtest run with real Kronos weights *or* a deterministic stand-in.

Mechanics
---------
* Entries fill at the **next bar's open** (no look-ahead): a signal computed
  from the window ending at bar ``t`` is executed at the open of bar ``t+1``.
* Exits (stop / take-profit) are evaluated against bar ``t+1``'s range using the
  risk manager, filling at the triggered level.
* Fees and slippage are charged by the :class:`~bibi.execution.PaperBroker`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from bibi.config import DeskConfig
from bibi.desk import Decision, ForecastFn
from bibi.execution import PaperBroker
from bibi.risk import RiskManager
from bibi.signal import build_signal
from bibi.sizing import kelly_size

logger = logging.getLogger("bibi.backtest")


@dataclass
class BacktestResult:
    """Outputs of a backtest run."""

    equity_curve: pd.Series                 # indexed by bar timestamp
    trades: pd.DataFrame                    # closed-trade blotter w/ R-multiples
    decisions: List[Decision]
    in_market: List[bool]
    timeframe: str

    @property
    def trade_R(self) -> List[float]:
        return self.trades["R"].tolist() if "R" in self.trades else []


class Backtester:
    """Single-symbol, walk-forward backtester sharing the desk's logic.

    Parameters
    ----------
    config:
        Desk configuration (costs, sizing, risk all come from here).
    forecast_fn:
        Forecast hook ``(symbol, window, pred_len) -> Forecast``.
    warmup:
        Bars to skip at the start so ATR / context windows are populated.
    """

    def __init__(self, config: DeskConfig, forecast_fn: ForecastFn,
                 warmup: int = 64) -> None:
        self.config = config
        self.forecast_fn = forecast_fn
        self.warmup = max(warmup, config.atr_period + 2)

    def run(self, candles: pd.DataFrame, symbol: str = "BTC/USDT") -> BacktestResult:
        """Replay ``candles`` bar by bar and return the run result."""
        broker = PaperBroker(self.config)
        risk = RiskManager(self.config)

        equity_points: List[float] = []
        equity_index: List[pd.Timestamp] = []
        in_market: List[bool] = []
        decisions: List[Decision] = []
        closed_trades: List[dict] = []

        n = len(candles)
        # We need a next bar to fill against, so stop at n-1.
        for t in range(self.warmup, n - 1):
            window = candles.iloc[: t + 1]               # ends at bar t
            next_bar = candles.iloc[t + 1]               # execution bar
            ts = candles.index[t + 1]
            mark = float(candles["close"].iloc[t])

            equity = broker.equity({symbol: mark})
            halted = risk.on_equity(equity, candles.index[t])

            # --- manage an open position against next_bar ------------------
            if risk.has_position(symbol):
                risk.update_trailing(symbol, float(next_bar["close"]))
                reason = risk.check_exit(symbol, next_bar)
                if reason is not None:
                    pos = risk.close(symbol)
                    exit_px = pos.stop if reason == "stop" else pos.take_profit
                    r_mult = pos.unrealized_R(exit_px)
                    broker.submit(symbol, -pos.side, pos.quantity, exit_px, ts)
                    closed_trades.append({
                        "ts": ts, "symbol": symbol, "side": pos.side,
                        "entry": pos.entry, "exit": exit_px, "R": r_mult,
                        "reason": reason,
                    })
                    decisions.append(Decision(ts, symbol, "exit",
                                              note=f"{reason} ({r_mult:+.2f}R)"))

            # --- consider a new entry (skip while halted) ------------------
            if not halted and not risk.has_position(symbol):
                self._maybe_enter(symbol, window, next_bar, ts, equity, broker, risk,
                                  decisions)

            # --- record equity at the close of the execution bar -----------
            close_mark = float(next_bar["close"])
            eq = broker.equity({symbol: close_mark})
            equity_points.append(eq)
            equity_index.append(ts)
            in_market.append(risk.has_position(symbol))

        equity_curve = pd.Series(equity_points, index=pd.DatetimeIndex(equity_index),
                                 name="equity")
        trades_df = pd.DataFrame(closed_trades)
        return BacktestResult(
            equity_curve=equity_curve,
            trades=trades_df,
            decisions=decisions,
            in_market=in_market,
            timeframe=self.config.timeframe,
        )

    # ----------------------------------------------------------------- entry
    def _maybe_enter(self, symbol, window, next_bar, ts, equity, broker, risk,
                     decisions) -> None:
        """Run forecast->signal->size and open at next bar's open if it fires."""
        forecast = self.forecast_fn(symbol, window, self.config.pred_len)
        signal = build_signal(forecast, self.config)
        if not signal.is_trade:
            return

        entry_px = float(next_bar["open"])           # fill at next open
        stop_frac = risk.stop_distance_frac(entry_px, window)
        sizing = kelly_size(signal, equity, entry_px, self.config,
                            stop_distance_frac=stop_frac,
                            open_positions=risk.open_count)
        if sizing.is_zero:
            return

        fill = broker.submit(symbol, signal.side, sizing.quantity, entry_px, ts)
        risk.build_position(symbol, signal.side, fill.price, sizing.quantity,
                            window, opened_at=ts)
        decisions.append(Decision(ts, symbol, "enter", signal=signal,
                                  sizing=sizing, fill=fill, note=signal.reason))
