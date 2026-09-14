"""Run the Bibi desk in paper mode on synthetic data.

This example needs no network and no model weights: it drives the desk with a
deterministic momentum forecaster over synthetic candles for two symbols and
prints every decision the desk makes, followed by the final paper equity.

Run::

    python examples/run_desk.py
"""

from __future__ import annotations

import os
import sys

# Allow running this example directly from the repo without installing.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import logging

from bibi.config import DeskConfig
from bibi.data import CandleFeed
from bibi.desk import Desk
from bibi.execution import PaperBroker
from backtest.run import momentum_forecast_fn


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    config = DeskConfig(
        symbols=["BTC/USDT", "ETH/USDT"], timeframe="1h",
        pred_len=24, kelly_fraction=0.25, conf_floor=0.4, max_positions=2,
    )

    # Deterministic synthetic candle windows for each symbol.
    windows = {
        "BTC/USDT": CandleFeed.synthetic(n=400, s0=30_000, seed=1),
        "ETH/USDT": CandleFeed.synthetic(n=400, s0=1_900, seed=2),
    }

    desk = Desk(
        config,
        feed=CandleFeed(timeframe=config.timeframe),
        broker=PaperBroker(config),
        forecast_fn=momentum_forecast_fn(),
    )

    # Walk a handful of steps, advancing the window by one bar each step so the
    # forecast/risk state evolves like a live loop would.
    print("=== desk decisions (paper) ===")
    start = 360
    for k in range(start, 395):
        snapshot = {sym: df.iloc[: k + 1] for sym, df in windows.items()}
        ts = windows["BTC/USDT"].index[k]
        decisions = desk.step(snapshot, ts)
        for d in decisions:
            if d.action in ("enter", "exit", "halt"):
                print(f"[{ts:%Y-%m-%d %H:%M}] {d}")

    marks = {sym: float(df["close"].iloc[394]) for sym, df in windows.items()}
    print("\n=== summary ===")
    print(f"final equity : {desk.equity(marks):,.2f}")
    print(f"decisions    : {len(desk.decisions)}")
    log = desk.decision_log()
    print(log[log["action"].isin(["enter", "exit"])].to_string(index=False))


if __name__ == "__main__":
    main()
