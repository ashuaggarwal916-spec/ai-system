"""R-multiple risk management.

Every trade is framed in terms of **R**, the initial risk: the quote-currency
distance from entry to the protective stop, times quantity. Profits and losses
are reported as multiples of that initial risk, which makes performance
comparable across symbols and position sizes.

Stops are placed using the Average True Range (ATR) so the protective distance
adapts to each symbol's volatility::

    stop_distance = atr_stop_mult * ATR(period)
    long  stop = entry - stop_distance ,  take-profit = entry + take_profit_R * stop_distance
    short stop = entry + stop_distance ,  take-profit = entry - take_profit_R * stop_distance

A simple trailing rule ratchets the stop in the trade's favour once price has
moved one R onside, locking in gains. A daily-drawdown kill-switch halts new
entries (and flags forced flattening) when equity falls more than
``max_daily_drawdown`` from the day's high-water mark.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional

import numpy as np
import pandas as pd

from bibi.config import DeskConfig


def average_true_range(candles: pd.DataFrame, period: int = 14) -> float:
    """Wilder's ATR over the last ``period`` bars of an OHLC frame.

    True Range = max(high-low, |high-prev_close|, |low-prev_close|). Returns the
    final ATR value (a scalar) using an exponential (Wilder) smoothing.
    """
    if len(candles) < 2:
        raise ValueError("ATR needs at least 2 bars")
    high = candles["high"].to_numpy(dtype=float)
    low = candles["low"].to_numpy(dtype=float)
    close = candles["close"].to_numpy(dtype=float)
    prev_close = np.concatenate([[close[0]], close[:-1]])

    tr = np.maximum.reduce([
        high - low,
        np.abs(high - prev_close),
        np.abs(low - prev_close),
    ])
    # Wilder smoothing == EMA with alpha = 1/period.
    atr = pd.Series(tr).ewm(alpha=1.0 / period, adjust=False).mean().iloc[-1]
    return float(atr)


@dataclass
class Position:
    """A live position tracked by the risk manager.

    Distinct from :class:`bibi.execution.Position` (the broker's accounting
    view); this one carries the stop/target geometry needed to manage the trade.
    """

    symbol: str
    side: int                 # +1 long, -1 short
    entry: float
    quantity: float
    stop: float
    take_profit: float
    r_unit: float             # quote risk per unit of price distance * qty (one R)
    opened_at: Optional[pd.Timestamp] = None
    high_water: float = field(default=0.0)   # best price seen (for trailing)

    def unrealized_R(self, price: float) -> float:
        """Open P&L expressed in R-multiples at ``price``."""
        if self.r_unit <= 0:
            return 0.0
        return self.side * (price - self.entry) * self.quantity / self.r_unit


class RiskManager:
    """Builds stops/targets, manages trailing, and runs the kill-switch."""

    def __init__(self, config: DeskConfig) -> None:
        self.config = config
        self.positions: Dict[str, Position] = {}
        self._day: Optional[pd.Timestamp] = None
        self._day_high_equity: float = config.starting_equity
        self.halted: bool = False

    # ------------------------------------------------------- position build
    def build_position(
        self, symbol: str, side: int, entry: float, quantity: float,
        candles: pd.DataFrame, opened_at: Optional[pd.Timestamp] = None,
    ) -> Position:
        """Create a managed :class:`Position` with ATR stop and R-multiple target."""
        atr = average_true_range(candles, self.config.atr_period)
        stop_dist = self.config.atr_stop_mult * atr
        if side > 0:
            stop = entry - stop_dist
            target = entry + self.config.take_profit_R * stop_dist
        else:
            stop = entry + stop_dist
            target = entry - self.config.take_profit_R * stop_dist

        r_unit = stop_dist * quantity  # quote value of one R
        pos = Position(
            symbol=symbol, side=side, entry=entry, quantity=quantity,
            stop=stop, take_profit=target, r_unit=r_unit, opened_at=opened_at,
            high_water=entry,
        )
        self.positions[symbol] = pos
        return pos

    def stop_distance_frac(self, entry: float, candles: pd.DataFrame) -> float:
        """Fractional stop distance for sizing's per-trade R cap."""
        atr = average_true_range(candles, self.config.atr_period)
        return (self.config.atr_stop_mult * atr) / entry if entry > 0 else 0.0

    # --------------------------------------------------------------- trailing
    def update_trailing(self, symbol: str, price: float) -> None:
        """Ratchet the stop once the trade is at least 1R onside.

        For a long, after price has advanced one R above entry, the stop is
        pulled up to ``price - stop_dist`` (never loosened). Symmetric for shorts.
        """
        pos = self.positions.get(symbol)
        if pos is None or pos.r_unit <= 0:
            return
        stop_dist = pos.r_unit / pos.quantity  # price distance of one R

        if pos.side > 0:
            pos.high_water = max(pos.high_water, price)
            if pos.high_water - pos.entry >= stop_dist:           # >= +1R
                pos.stop = max(pos.stop, pos.high_water - stop_dist)
        else:
            pos.high_water = min(pos.high_water, price) if pos.high_water else price
            if pos.entry - pos.high_water >= stop_dist:           # >= +1R
                pos.stop = min(pos.stop, pos.high_water + stop_dist)

    def check_exit(self, symbol: str, bar: pd.Series) -> Optional[str]:
        """Return an exit reason if ``bar`` triggers stop or target, else ``None``.

        Intrabar both levels may be touched; we conservatively assume the
        *stop* fills first (worst case) when a single bar spans both.
        """
        pos = self.positions.get(symbol)
        if pos is None:
            return None
        high, low = float(bar["high"]), float(bar["low"])
        if pos.side > 0:
            if low <= pos.stop:
                return "stop"
            if high >= pos.take_profit:
                return "take_profit"
        else:
            if high >= pos.stop:
                return "stop"
            if low <= pos.take_profit:
                return "take_profit"
        return None

    def close(self, symbol: str) -> Optional[Position]:
        """Remove and return a managed position (after the broker fills it)."""
        return self.positions.pop(symbol, None)

    # ------------------------------------------------------------ kill-switch
    def on_equity(self, equity: float, ts: pd.Timestamp) -> bool:
        """Update the daily drawdown watchdog; return ``True`` if halted.

        Tracks the intraday high-water mark per UTC day and trips ``halted``
        when equity drops more than ``max_daily_drawdown`` below it. The flag
        resets at the start of each new UTC day.
        """
        day = ts.normalize()
        if self._day is None or day != self._day:
            self._day = day
            self._day_high_equity = equity
            self.halted = False

        self._day_high_equity = max(self._day_high_equity, equity)
        dd = 1.0 - equity / self._day_high_equity if self._day_high_equity > 0 else 0.0
        if dd >= self.config.max_daily_drawdown:
            self.halted = True
        return self.halted

    @property
    def open_count(self) -> int:
        return len(self.positions)

    def has_position(self, symbol: str) -> bool:
        return symbol in self.positions
