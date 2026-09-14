"""CLI entry point for the Bibi backtester.

Examples
--------
Run on synthetic data with the default config::

    python -m backtest.run --synthetic --bars 1500

Run on a CSV of OHLCV candles (columns: timestamp, open, high, low, close,
volume[, amount])::

    python -m backtest.run --csv data/btc_1h.csv --timeframe 1h

By default the backtest uses a lightweight, deterministic momentum forecaster
so it runs with no model weights and no network. Pass ``--kronos`` to load the
real Kronos model instead.
"""

from __future__ import annotations

import argparse
import logging
import sys
from typing import Callable

import numpy as np
import pandas as pd

from bibi.config import DeskConfig
from bibi.data import CandleFeed, normalize
from bibi.engine import Forecast, KronosForecaster
from backtest.backtester import Backtester
from backtest.metrics import compute_metrics


def momentum_forecast_fn(lookback: int = 24, vol_window: int = 24) -> Callable:
    """Build a deterministic stand-in forecaster for weight-free backtests.

    The expected horizon return is the recent mean log-return scaled to the
    forecast horizon (a simple momentum prior); sigma is the trailing realised
    volatility scaled by ``sqrt(pred_len)``. This produces a self-consistent
    :class:`~bibi.engine.Forecast` so the desk's signal/sizing math is exercised
    end-to-end without loading Kronos.
    """

    def _fn(symbol: str, window: pd.DataFrame, pred_len: int) -> Forecast:
        close = window["close"].to_numpy(dtype=float)
        last_close = float(close[-1])
        log_rets = np.diff(np.log(close[-(lookback + 1):]))
        per_bar = float(np.mean(log_rets)) if len(log_rets) else 0.0
        e_r = per_bar * pred_len

        vol_rets = np.diff(np.log(close[-(vol_window + 1):]))
        per_bar_vol = float(np.std(vol_rets, ddof=1)) if len(vol_rets) > 1 else 0.01
        sigma = per_bar_vol * np.sqrt(pred_len)

        direction = int(np.sign(e_r)) if abs(e_r) > 1e-9 else 0
        mean_path = last_close * np.exp(np.cumsum(np.full(pred_len, per_bar)))
        bars = pd.DataFrame({
            "open": mean_path, "high": mean_path, "low": mean_path,
            "close": mean_path, "volume": np.zeros(pred_len),
            "amount": np.zeros(pred_len),
        })
        return Forecast(symbol, e_r, max(sigma, 1e-6), direction, last_close,
                        mean_path, bars, n_paths=1)

    return _fn


def kronos_forecast_fn(config: DeskConfig) -> Callable:
    """Load real Kronos weights and adapt the forecaster to the backtest hook."""
    forecaster = KronosForecaster(config).load()
    return lambda symbol, window, pred_len: forecaster.forecast(symbol, window, pred_len)


def load_candles(args: argparse.Namespace) -> pd.DataFrame:
    """Resolve the candle source from CLI args."""
    if args.csv:
        df = pd.read_csv(args.csv)
        ts_col = next((c for c in df.columns if c.lower() in ("timestamp", "ts", "date", "time")), None)
        if ts_col is not None:
            df[ts_col] = pd.to_datetime(df[ts_col], utc=True)
            df = df.set_index(ts_col).sort_index()
        return normalize(df)
    # synthetic fallback
    return CandleFeed.synthetic(n=args.bars, timeframe=args.timeframe, seed=args.seed)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Bibi desk backtester")
    src = p.add_mutually_exclusive_group()
    src.add_argument("--csv", type=str, help="path to an OHLCV CSV")
    src.add_argument("--synthetic", action="store_true",
                     help="use the synthetic generator (default)")
    p.add_argument("--bars", type=int, default=1500, help="synthetic bar count")
    p.add_argument("--seed", type=int, default=7, help="synthetic RNG seed")
    p.add_argument("--symbol", type=str, default="BTC/USDT")
    p.add_argument("--timeframe", type=str, default="1h")
    p.add_argument("--model", type=str, default="Kronos-small")
    p.add_argument("--pred-len", type=int, default=24)
    p.add_argument("--kelly", type=float, default=0.25, dest="kelly_fraction")
    p.add_argument("--conf-floor", type=float, default=0.5)
    p.add_argument("--kronos", action="store_true",
                   help="use real Kronos weights instead of the momentum stand-in")
    p.add_argument("--warmup", type=int, default=64)
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = DeskConfig(
        symbols=[args.symbol], timeframe=args.timeframe, model_name=args.model,
        pred_len=args.pred_len, kelly_fraction=args.kelly_fraction,
        conf_floor=args.conf_floor,
    )
    candles = load_candles(args)
    logging.getLogger("bibi.backtest").info(
        "loaded %d %s bars for %s", len(candles), args.timeframe, args.symbol
    )

    forecast_fn = kronos_forecast_fn(config) if args.kronos else momentum_forecast_fn()
    bt = Backtester(config, forecast_fn, warmup=args.warmup)
    result = bt.run(candles, symbol=args.symbol)

    report = compute_metrics(
        result.equity_curve.tolist(), result.trade_R, result.in_market,
        timeframe=args.timeframe,
    )

    print()
    print(f"  Bibi backtest - {args.symbol} {args.timeframe} "
          f"({'Kronos' if args.kronos else 'momentum stand-in'})")
    print("  " + "-" * 46)
    print(report.as_table())
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
