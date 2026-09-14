"""OHLCV ingestion and shaping for Kronos.

Kronos consumes a DataFrame with columns
``[open, high, low, close, volume, amount]`` indexed (implicitly) by an
aligned timestamp series. ``amount`` is the quote-currency turnover for the
bar; many exchanges expose it directly, but when they do not we synthesise it
as ``close * volume`` which is a standard approximation for a single bar.

:class:`CandleFeed` wraps ccxt for live ingestion and also ships a synthetic
generator so the rest of the package (and the test-suite) runs with no network
and no exchange keys.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np
import pandas as pd

# Canonical column order Kronos expects.
OHLCV_COLUMNS: Sequence[str] = ("open", "high", "low", "close", "volume", "amount")

# Mapping of common ccxt timeframes to pandas offset aliases for resampling.
_TF_TO_PANDAS = {
    "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
    "1d": "1D", "1w": "1W",
}


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce an arbitrary OHLCV frame into Kronos' canonical schema.

    - lower-cases columns,
    - synthesises ``amount = close * volume`` when missing,
    - drops rows with NaN OHLC,
    - returns columns in :data:`OHLCV_COLUMNS` order.

    The input index is preserved (callers are expected to keep a
    DatetimeIndex), but the function does not require one.
    """
    out = df.copy()
    out.columns = [str(c).lower() for c in out.columns]

    missing = {"open", "high", "low", "close", "volume"} - set(out.columns)
    if missing:
        raise ValueError(f"OHLCV frame missing columns: {sorted(missing)}")

    if "amount" not in out.columns:
        out["amount"] = out["close"] * out["volume"]

    out = out.dropna(subset=["open", "high", "low", "close"])
    return out.loc[:, list(OHLCV_COLUMNS)]


@dataclass
class CandleFeed:
    """Pulls and shapes OHLCV candles for one or more symbols.

    Parameters
    ----------
    exchange_id:
        ccxt exchange id. Defaults to Binance spot.
    timeframe:
        Candle period (ccxt notation).
    enable_rate_limit:
        Forwarded to ccxt; keep ``True`` to respect exchange limits.
    """

    exchange_id: str = "binance"
    timeframe: str = "1h"
    enable_rate_limit: bool = True

    _exchange: object = None  # lazily constructed ccxt client

    # ------------------------------------------------------------------ ccxt
    def _client(self):
        """Construct (once) and return the underlying ccxt exchange client."""
        if self._exchange is None:
            import ccxt  # local import: ccxt is heavy and optional for tests

            klass = getattr(ccxt, self.exchange_id)
            self._exchange = klass({"enableRateLimit": self.enable_rate_limit})
        return self._exchange

    def fetch(self, symbol: str, limit: int = 512,
              since: Optional[int] = None) -> pd.DataFrame:
        """Fetch the most recent ``limit`` candles for ``symbol``.

        Returns a normalised, time-indexed Kronos frame. ``since`` is an
        optional millisecond epoch lower bound passed through to ccxt.
        """
        client = self._client()
        raw = client.fetch_ohlcv(
            symbol, timeframe=self.timeframe, since=since, limit=limit
        )
        # ccxt rows: [ts_ms, open, high, low, close, volume]
        df = pd.DataFrame(
            raw, columns=["ts", "open", "high", "low", "close", "volume"]
        )
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        df = df.set_index("ts").sort_index()
        return normalize(df)

    # -------------------------------------------------------------- resample
    def resample(self, df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
        """Aggregate a finer frame up to a coarser ``timeframe``.

        Uses the standard OHLCV aggregation (first/max/min/last + summed
        volume and amount). Useful when an exchange only serves 1m bars but the
        desk trades 1h.
        """
        rule = _TF_TO_PANDAS.get(timeframe)
        if rule is None:
            raise ValueError(f"unsupported resample timeframe {timeframe!r}")
        if not isinstance(df.index, pd.DatetimeIndex):
            raise TypeError("resample requires a DatetimeIndex")

        agg = {
            "open": "first", "high": "max", "low": "min", "close": "last",
            "volume": "sum", "amount": "sum",
        }
        out = df.resample(rule, label="right", closed="right").agg(agg)
        return normalize(out.dropna(subset=["open"]))

    # ------------------------------------------------------------- synthetic
    @staticmethod
    def synthetic(
        n: int = 600,
        start: str = "2024-01-01",
        timeframe: str = "1h",
        s0: float = 30_000.0,
        mu: float = 0.0,
        sigma: float = 0.02,
        seed: Optional[int] = 7,
    ) -> pd.DataFrame:
        """Generate a believable synthetic OHLCV series via GBM + intrabar noise.

        Closes follow a geometric Brownian motion with per-bar drift ``mu`` and
        volatility ``sigma``. Highs/lows are drawn as exponential wicks around
        the open/close range so candles look organic. Returned frame is already
        normalised.

        This is deterministic for a fixed ``seed`` and is what the tests and
        the weight-free backtest path consume.
        """
        rng = np.random.default_rng(seed)
        freq = _TF_TO_PANDAS.get(timeframe, "1h")
        idx = pd.date_range(start=start, periods=n, freq=freq, tz="UTC")

        # log-returns -> close path
        shocks = rng.normal(loc=mu, scale=sigma, size=n)
        log_close = np.log(s0) + np.cumsum(shocks)
        close = np.exp(log_close)
        open_ = np.empty(n)
        open_[0] = s0
        open_[1:] = close[:-1]  # next bar opens at previous close

        body_hi = np.maximum(open_, close)
        body_lo = np.minimum(open_, close)
        # wicks scale with bar volatility
        up_wick = body_hi * (1.0 + np.abs(rng.normal(0.0, sigma / 2, n)))
        dn_wick = body_lo * (1.0 - np.abs(rng.normal(0.0, sigma / 2, n)))
        high = np.maximum(body_hi, up_wick)
        low = np.minimum(body_lo, dn_wick)

        # volume loosely anti-correlated with price, always positive
        base_vol = rng.lognormal(mean=4.0, sigma=0.6, size=n)
        volume = base_vol * (1.0 + 3.0 * np.abs(shocks))

        df = pd.DataFrame(
            {
                "open": open_, "high": high, "low": low, "close": close,
                "volume": volume,
            },
            index=idx,
        )
        return normalize(df)


def split_context_target(
    df: pd.DataFrame, pred_len: int
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split a frame into (context, held-out target) for walk-forward tests.

    The last ``pred_len`` rows become the target; everything before is context.
    """
    if len(df) <= pred_len:
        raise ValueError("frame too short to hold out a target window")
    return df.iloc[:-pred_len].copy(), df.iloc[-pred_len:].copy()
