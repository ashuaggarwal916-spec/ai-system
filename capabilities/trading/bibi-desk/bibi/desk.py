"""The Desk loop - the centrepiece that wires every stage together.

For each symbol on each step the desk:

    1. pulls the latest candles                        (CandleFeed)
    2. forecasts the horizon with Kronos               (KronosForecaster)
    3. derives a cost-aware signal                     (signal.build_signal)
    4. sizes the trade with fractional Kelly           (sizing.kelly_size)
    5. checks risk (slots, kill-switch, ATR stop)      (RiskManager)
    6. executes via the broker                          (PaperBroker / LiveBroker)

Every step yields a :class:`Decision` capturing exactly why the desk acted (or
did not). The desk is deliberately stateless between symbols within a step and
keeps all mutable state in the broker and risk manager, which makes it easy to
reason about and to replay in the backtester.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

import pandas as pd

from bibi.config import DeskConfig
from bibi.data import CandleFeed
from bibi.engine import Forecast, KronosForecaster
from bibi.execution import Execution, Fill, PaperBroker
from bibi.risk import RiskManager
from bibi.signal import Signal, build_signal
from bibi.sizing import SizingResult, kelly_size

logger = logging.getLogger("bibi.desk")

# A forecast function lets the backtester (or tests) inject deterministic
# forecasts without loading model weights. Signature mirrors the forecaster.
ForecastFn = Callable[[str, pd.DataFrame, int], Forecast]


@dataclass
class Decision:
    """A fully audited record of one symbol's evaluation on one step."""

    ts: Optional[pd.Timestamp]
    symbol: str
    action: str                         # "enter" | "hold" | "skip" | "exit" | "halt"
    signal: Optional[Signal] = None
    sizing: Optional[SizingResult] = None
    fill: Optional[Fill] = None
    note: str = ""

    def __str__(self) -> str:
        bits = [f"{self.symbol:<10} {self.action.upper():<5}"]
        if self.signal is not None:
            bits.append(f"side={self.signal.side:+d} alpha={self.signal.alpha:.3f}")
        if self.sizing is not None and not self.sizing.is_zero:
            bits.append(f"notional={self.sizing.notional:,.0f}")
        if self.note:
            bits.append(f"| {self.note}")
        return "  ".join(bits)


class Desk:
    """Orchestrates the full forecast -> signal -> size -> risk -> execute loop.

    Parameters
    ----------
    config:
        The desk configuration.
    feed:
        Candle source. Defaults to a Binance :class:`CandleFeed`.
    forecaster:
        A loaded :class:`KronosForecaster`. Optional if ``forecast_fn`` is given.
    broker:
        Execution venue. Defaults to a :class:`PaperBroker`.
    forecast_fn:
        Optional injected forecast function (used by the backtester/tests to run
        without model weights). Takes precedence over ``forecaster`` if set.
    """

    def __init__(
        self,
        config: DeskConfig,
        feed: Optional[CandleFeed] = None,
        forecaster: Optional[KronosForecaster] = None,
        broker: Optional[Execution] = None,
        forecast_fn: Optional[ForecastFn] = None,
    ) -> None:
        self.config = config
        self.feed = feed or CandleFeed(timeframe=config.timeframe)
        self.forecaster = forecaster
        self.broker: Execution = broker or PaperBroker(config)
        self.risk = RiskManager(config)
        self.forecast_fn = forecast_fn
        self.decisions: List[Decision] = []

    # ------------------------------------------------------------- forecast
    def _forecast(self, symbol: str, candles: pd.DataFrame) -> Forecast:
        if self.forecast_fn is not None:
            return self.forecast_fn(symbol, candles, self.config.pred_len)
        if self.forecaster is None:
            raise RuntimeError("Desk needs either a forecaster or a forecast_fn")
        return self.forecaster.forecast(symbol, candles, self.config.pred_len)

    # ----------------------------------------------------------------- step
    def step(self, candles_by_symbol: Dict[str, pd.DataFrame],
             ts: Optional[pd.Timestamp] = None) -> List[Decision]:
        """Evaluate every symbol once against the supplied candle windows.

        ``candles_by_symbol`` maps symbol -> normalised OHLCV window ending at
        the current bar. The desk uses the last close as the mark and assumes
        the *next* bar's open is unavailable yet, so entries are recorded at the
        last close (the paper broker adds slippage). Returns the per-symbol
        decisions, which are also appended to ``self.decisions``.
        """
        marks = {s: float(df["close"].iloc[-1]) for s, df in candles_by_symbol.items()}
        equity = self.broker.equity(marks)
        halted = self.risk.on_equity(equity, ts or pd.Timestamp.utcnow())

        step_decisions: List[Decision] = []

        # --- manage existing positions first (stops/targets/trailing) ------
        for symbol, candles in candles_by_symbol.items():
            if self.risk.has_position(symbol):
                step_decisions.append(self._manage(symbol, candles, ts))

        if halted:
            d = Decision(ts, "*", "halt",
                         note=f"kill-switch: daily DD >= {self.config.max_daily_drawdown:.0%}")
            logger.warning("desk halted: %s", d.note)
            step_decisions.append(d)
            self.decisions.extend(step_decisions)
            return step_decisions

        # --- look for new entries ------------------------------------------
        for symbol, candles in candles_by_symbol.items():
            if self.risk.has_position(symbol):
                continue  # already in this symbol
            step_decisions.append(self._consider_entry(symbol, candles, equity, ts))

        self.decisions.extend(step_decisions)
        return step_decisions

    # ------------------------------------------------------------- managing
    def _manage(self, symbol: str, candles: pd.DataFrame,
                ts: Optional[pd.Timestamp]) -> Decision:
        """Trail the stop and exit if the latest bar hit stop/target."""
        last_bar = candles.iloc[-1]
        price = float(last_bar["close"])
        self.risk.update_trailing(symbol, price)

        exit_reason = self.risk.check_exit(symbol, last_bar)
        if exit_reason is None:
            return Decision(ts, symbol, "hold", note="position open")

        pos = self.risk.close(symbol)
        assert pos is not None
        # close at the triggered level (stop or target), conservative.
        exit_px = pos.stop if exit_reason == "stop" else pos.take_profit
        fill = self.broker.submit(symbol, -pos.side, pos.quantity, exit_px, ts)
        r_mult = pos.unrealized_R(exit_px)
        return Decision(ts, symbol, "exit", fill=fill,
                        note=f"{exit_reason} @ {exit_px:.2f}  ({r_mult:+.2f}R)")

    # -------------------------------------------------------------- entries
    def _consider_entry(self, symbol: str, candles: pd.DataFrame,
                        equity: float, ts: Optional[pd.Timestamp]) -> Decision:
        """Run the forecast->signal->size->risk pipeline for a flat symbol."""
        forecast = self._forecast(symbol, candles)
        signal = build_signal(forecast, self.config)
        if not signal.is_trade:
            return Decision(ts, symbol, "skip", signal=signal, note=signal.reason)

        price = forecast.last_close
        stop_frac = self.risk.stop_distance_frac(price, candles)
        sizing = kelly_size(
            signal, equity, price, self.config,
            stop_distance_frac=stop_frac,
            open_positions=self.risk.open_count,
        )
        if sizing.is_zero:
            return Decision(ts, symbol, "skip", signal=signal, sizing=sizing,
                            note=f"sized to zero ({sizing.binding_cap} cap)")

        # open the position
        fill = self.broker.submit(symbol, signal.side, sizing.quantity, price, ts)
        self.risk.build_position(
            symbol, signal.side, fill.price, sizing.quantity, candles, opened_at=ts
        )
        return Decision(
            ts, symbol, "enter", signal=signal, sizing=sizing, fill=fill,
            note=f"{signal.reason}; f={sizing.kelly_fraction:.3f} "
                 f"({sizing.binding_cap})",
        )

    # ---------------------------------------------------------------- loops
    def run_once(self) -> List[Decision]:
        """Pull live candles for every symbol and run one step.

        Requires a network-capable :class:`CandleFeed` and a loaded forecaster.
        """
        candles = {
            sym: self.feed.fetch(sym, limit=self.config.max_context + 1)
            for sym in self.config.symbols
        }
        ts = pd.Timestamp.utcnow()
        decisions = self.step(candles, ts)
        for d in decisions:
            logger.info("%s", d)
        return decisions

    def run(self, steps: Optional[int] = None, poll_seconds: float = 3600.0) -> None:
        """Run the desk live in a polling loop.

        Parameters
        ----------
        steps:
            Number of iterations; ``None`` runs forever.
        poll_seconds:
            Sleep between iterations (default one hour for a 1h timeframe).
        """
        import time

        i = 0
        while steps is None or i < steps:
            try:
                self.run_once()
            except Exception:  # pragma: no cover - resilience in the live loop
                logger.exception("desk step failed; continuing")
            i += 1
            if steps is not None and i >= steps:
                break
            time.sleep(poll_seconds)

    # ------------------------------------------------------------- reporting
    def equity(self, marks: Dict[str, float]) -> float:
        return self.broker.equity(marks)

    def decision_log(self) -> pd.DataFrame:
        """Return the full decision history as a DataFrame."""
        return pd.DataFrame(
            [
                {
                    "ts": d.ts, "symbol": d.symbol, "action": d.action,
                    "side": d.signal.side if d.signal else 0,
                    "alpha": d.signal.alpha if d.signal else 0.0,
                    "notional": d.sizing.notional if d.sizing else 0.0,
                    "note": d.note,
                }
                for d in self.decisions
            ]
        )
