"""Minimal Kronos forecast example.

Loads the Kronos-small checkpoint, pulls recent BTC 1h candles from Binance via
ccxt, forecasts the next 24 bars, and prints the expected return, forecast
volatility and direction.

Run::

    python examples/forecast_btc.py

Requires network access and the Kronos model package on the import path. If you
only want to exercise the desk logic without weights, see ``examples/run_desk.py``
which uses the synthetic feed.
"""

from __future__ import annotations

import os
import sys

# Allow running this example directly from the repo without installing.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import logging

from bibi.config import DeskConfig
from bibi.data import CandleFeed
from bibi.engine import KronosForecaster


def main() -> None:
    logging.basicConfig(level=logging.INFO)

    config = DeskConfig(
        symbols=["BTC/USDT"], timeframe="1h",
        model_name="Kronos-small", pred_len=24, sample_count=30,
    )

    # 1) ingest candles
    feed = CandleFeed(timeframe=config.timeframe)
    candles = feed.fetch("BTC/USDT", limit=config.max_context + 1)
    print(f"fetched {len(candles)} BTC/USDT {config.timeframe} candles")
    print(candles.tail(3))

    # 2) load Kronos and forecast
    forecaster = KronosForecaster(config).load()
    forecast = forecaster.forecast("BTC/USDT", candles, pred_len=config.pred_len)

    # 3) report
    print("\n--- forecast ---")
    print(f"last close      : {forecast.last_close:,.2f}")
    print(f"E[r] (24h)      : {forecast.expected_return:+.4f}")
    print(f"sigma           : {forecast.sigma:.4f}")
    print(f"direction       : {forecast.direction:+d}")
    print(f"implied price   : {forecast.expected_price:,.2f}")
    print(f"info ratio      : {forecast.sharpe_like:.3f}")
    print(f"paths aggregated: {forecast.n_paths}")


if __name__ == "__main__":
    main()
