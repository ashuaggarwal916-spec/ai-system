<div align="center">

![WrappedBibi](figures/banner.png)

# 🎩 Bibi Desk

**An open, autonomous crypto-trading desk - powered by [Kronos](https://github.com/shiyu-coder/Kronos), the foundation model for financial candlesticks.**

Bibi forecasts the market, sizes the risk like a quant, and executes around the clock. The whole desk is open code you can read, fork, and run.

[![License: MIT](https://img.shields.io/badge/License-MIT-D8A84B.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-3776AB.svg)](https://www.python.org)
[![Powered by Kronos](https://img.shields.io/badge/forecasts-Kronos-D8A84B.svg)](https://github.com/shiyu-coder/Kronos)
[![Status](https://img.shields.io/badge/desk-online-5BBF8A.svg)](https://wrappedbibi.com)
[![Twitter](https://img.shields.io/badge/𝕏-@WrappedBibi-1DA1F2.svg)](https://x.com/WrappedBibi)

[**Website**](https://wrappedbibi.com) · [**𝕏 / Twitter**](https://x.com/WrappedBibi) · [**Strategy**](docs/strategy.md) · [**Kronos**](https://github.com/shiyu-coder/Kronos)

</div>

---

## What is this

Most "AI trading" projects are a chart and a promise. **Bibi Desk is the opposite - a real, documented strategy you can audit line by line.**

At its core sits **Kronos**, the first open-source foundation model for financial K-lines (candlesticks), trained on data from 45+ global exchanges. Kronos forecasts the next bars; Bibi turns those forecasts into cost-aware signals, sizes them with fractional Kelly, and manages the risk on R-multiples. No black box, no "secret indicator" - just a forecast, an edge, and disciplined sizing.

`$wBibi` is the token that wraps the brand and the desk into one tradable asset on **BNB Chain**. This repo is the engine behind the face.

> **Bibi's rule:** *edge minus cost, sized by risk, executed without flinching.*

---

## The pipeline

Every decision Bibi makes runs the same five steps - all in this repo, all in the open:

```
┌──────────┐   ┌───────────┐   ┌──────────┐   ┌────────┐   ┌──────────┐
│  INGEST  │ → │  FORECAST │ → │  SIGNAL  │ → │  SIZE  │ → │ EXECUTE  │
│  OHLCV   │   │  Kronos   │   │ edge−cost│   │ Kelly  │   │ R-managed│
└──────────┘   └───────────┘   └──────────┘   └────────┘   └──────────┘
   data.py        engine.py       signal.py    sizing.py   execution.py
                                          └─ desk.py orchestrates ─┘
```

1. **Ingest** - live OHLCV across majors, normalized into clean candles (`bibi/data.py`).
2. **Forecast** - Kronos predicts the next bars; we run Monte-Carlo sample paths and read off `E[r]` and dispersion `σ` (`bibi/engine.py`).
3. **Signal** - `edge = E[r] − cost`. Only edges that clear fees + a confidence floor fire (`bibi/signal.py`).
4. **Size** - fractional-Kelly off edge and volatility, clamped and risk-capped (`bibi/sizing.py`).
5. **Execute** - enter, manage with ATR stops on R-multiples, exit (`bibi/risk.py`, `bibi/execution.py`).

<div align="center">
  <img src="https://raw.githubusercontent.com/shiyu-coder/Kronos/master/figures/overview.png" width="720" alt="Kronos architecture"/>
  <br/><sub>The forecasting core - Kronos' two-stage tokenizer + autoregressive transformer. <a href="https://github.com/shiyu-coder/Kronos">(shiyu-coder/Kronos)</a></sub>
</div>

---

## Model Zoo

Bibi runs on any open Kronos checkpoint (pulled from the Hugging Face Hub):

| Model | Tokenizer | Context | Params | Use |
|-------|-----------|---------|--------|-----|
| `Kronos-mini`  | Kronos-Tokenizer-2k   | 2048 | 4.1M   | low-latency / many symbols |
| `Kronos-small` | Kronos-Tokenizer-base | 512  | 24.7M  | **default** - best speed/quality |
| `Kronos-base`  | Kronos-Tokenizer-base | 512  | 102.3M | higher-conviction forecasts |

Set the checkpoint in `DeskConfig(model="NeoQuasar/Kronos-small")`.

---

## Getting started

```bash
git clone https://github.com/WrappedBibi/bibi-desk.git
cd bibi-desk
pip install -r requirements.txt
```

**Forecast in three lines** (`examples/forecast_btc.py`):

```python
from bibi.engine import KronosForecaster
from bibi.data import CandleFeed

candles = CandleFeed(exchange="binance").fetch("BTC/USDT", timeframe="1h", limit=512)
fc = KronosForecaster(model="NeoQuasar/Kronos-small").load().forecast(candles, pred_len=24)

print(fc)   # Forecast(E[r]=+1.84%, sigma=2.1%, dir=LONG, conf=0.74)
```

**Run the desk in paper mode** (`examples/run_desk.py`):

```python
from bibi.config import DeskConfig
from bibi.desk import Desk

cfg = DeskConfig(
    symbols=["BTC/USDT", "ETH/USDT", "BNB/USDT"],
    timeframe="1h",
    model="NeoQuasar/Kronos-small",
    kelly_fraction=0.5,     # half-Kelly
    fee_bps=10, slippage_bps=5,
    conf_floor=0.6,         # only act above 0.6·σ of edge
)

desk = Desk(cfg)
desk.run()   # ingest → forecast → signal → size → execute, logged every step
```

---

## The strategy, in math

Bibi is deliberately boring - the boring stuff is what keeps you alive. Full writeup in [`docs/strategy.md`](docs/strategy.md).

**Signal** - the Kronos forecast, net of cost:

```
s = E[ r_{t+1} | Kronos(x_{t-512:t}) ] − (fee + slippage(q))
fire  ⟺  s > κ · σ          (κ = confidence floor)
```

**Position size** - fractional Kelly, edge over variance:

```
f* = ( E[edge] − fees ) / σ²  ·  λ            (λ = ½, half-Kelly)
notional = clamp( f* · equity,  0,  risk_per_trade_R · equity )
```

**Risk** - every trade is framed in R (risk units): an ATR stop defines 1R, take-profit sits at `k·R`, and a daily-drawdown kill-switch flattens the book. Expectancy is tracked in R, not in noisy PnL.

<div align="center">
  <img src="https://raw.githubusercontent.com/shiyu-coder/Kronos/master/figures/prediction_example.png" width="760" alt="Kronos forecast example"/>
  <br/><sub>A Kronos forecast vs. realized path - direction + magnitude on unseen data.</sub>
</div>

---

## Backtesting

The backtester is event-driven (`backtest/`), walks bars one at a time, applies fees + slippage, and reports the metrics that actually matter:

```bash
python -m backtest.run --data data/BTCUSDT_1h.csv --model NeoQuasar/Kronos-small --fee-bps 10
```

```
─────────────────────────────────────────────
  Hit rate          58.4 %      (5,200 trades)
  Sharpe (ann.)      2.13       net of fees
  Sortino            3.01
  Profit factor      1.74
  Expectancy        +0.41 R
  Avg win / loss     1.7 R
  Max drawdown      -11.8 %
─────────────────────────────────────────────
```

> ⚠️ **These are backtested / simulated figures on the open model - illustrative, not a promise of returns.** Read the code and run it yourself. Markets change; past results do not predict the future.

---

## Repo layout

```
bibi-desk/
├── bibi/                  # the desk (Python)
│   ├── config.py          # DeskConfig + loaders
│   ├── data.py            # OHLCV ingestion (ccxt)
│   ├── engine.py          # KronosForecaster, the forecasting core
│   ├── signal.py          # forecast → cost-aware signal
│   ├── sizing.py          # fractional-Kelly sizing
│   ├── risk.py            # R-multiple risk + kill-switch
│   ├── execution.py       # paper + live brokers (calls the engine)
│   └── desk.py            # the orchestration loop
├── execution-engine/      # low-latency order router + fill sim (Rust)
├── backtest/              # event-driven backtester + metrics
├── notebooks/             # strategy_research.ipynb, the math written out
├── examples/              # forecast + run-the-desk demos
├── scripts/               # setup / run / backtest helpers (bash)
├── docs/strategy.md       # the strategy and the math
├── Dockerfile             # builds the Rust engine + ships it with the desk
└── tests/                 # unit tests
```

## Architecture

The desk is two pieces that talk over line-delimited JSON:

- **Python** does the thinking: ingest, Kronos forecast, signal, Kelly sizing, R-multiple risk.
- **Rust** (`execution-engine/`) does the placing: a smart order router (market / limit / TWAP / iceberg) in front of a pre-trade risk gate, with a deterministic fill simulator for paper mode. Python shells out to it so the hot path stays fast and the trading logic stays readable. See `execution-engine/README.md` for the protocol.

For a live view of a running desk (signal feed, equity curve, positions, forecasts), see the companion dashboard repo: **[bibi-terminal](https://github.com/WrappedBibi/bibi-terminal)** (Next.js + TypeScript).

---

## $wBibi

`$wBibi` wraps the brand + this engine into a single token on **BNB Chain**. The desk is open; the token rides the narrative. → [wrappedbibi.com](https://wrappedbibi.com) · [@WrappedBibi](https://x.com/WrappedBibi)

## Disclaimer

This is research / educational open-source software, **not financial advice, not a managed fund, and not a guarantee of returns.** `$wBibi` is a community token. Forecasts are probabilistic and frequently wrong. Trading crypto carries substantial risk of loss - only deploy capital you can afford to lose, and do your own research.

## Acknowledgements & citation

Forecasting is powered by **Kronos** ([shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos), MIT). If you use this work, please cite the Kronos paper:

```bibtex
@article{kronos2025,
  title   = {Kronos: A Foundation Model for the Language of Financial Markets},
  author  = {Shi, Yu and others},
  journal = {arXiv preprint arXiv:2508.02739},
  year    = {2025}
}
```

## License

[MIT](LICENSE) © WrappedBibi
