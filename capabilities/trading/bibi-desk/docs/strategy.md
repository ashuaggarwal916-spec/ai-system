# Bibi Desk - Strategy & Math

Bibi is a cost-aware, volatility-scaled trading desk built on top of the
[Kronos](https://github.com/shiyu-coder/Kronos) candlestick foundation model.
The pipeline is a straight line, and every stage is a small, testable function:

```
candles ──► forecast ──► signal ──► sizing ──► risk ──► execution
 (data)     (engine)     (signal)   (sizing)   (risk)   (execution)
```

This document explains the model assumptions and the three pieces of math that
matter: the **forecast confidence**, the **cost-aware signal**, and the
**fractional-Kelly sizing**, plus the **R-multiple** risk framing.

---

## 1. Forecast: turning Kronos samples into `(E[r], σ)`

Kronos is a *generative* model of future candles. For a horizon of `H` bars we
draw `N = sample_count` Monte-Carlo paths. Let `S₀` be the last observed close
and `Sₙ,ₕ` the terminal close of path `n`. The per-path horizon log-return is

```
rₙ = ln( Sₙ,H / S₀ )
```

We summarise the bundle of paths by its first two moments:

```
E[r] = (1/N) · Σ rₙ                     # point forecast (drift)
σ    = sqrt( (1/(N-1)) · Σ (rₙ - E[r])² )   # forecast uncertainty
```

The key idea: **dispersion is confidence**. A tight bundle of paths (small `σ`)
means Kronos is sure; a wide fan (large `σ`) means it is not, and we should bet
less or not at all. The forecast "information ratio" is `E[r] / σ`.

---

## 2. Signal: a cost-aware, volatility-scaled gate

A forecast is only tradeable if the expected move clears **both** trading costs
**and** a volatility hurdle. With round-trip friction

```
cost = (fee_bps + slippage_bps) / 10⁴
```

we define the net **edge** and the confidence **hurdle**:

```
edge   = |E[r]| − cost
hurdle = conf_floor · σ
```

The desk fires a trade iff

```
edge > hurdle           # i.e. |E[r]| − cost > conf_floor · σ
side  = sign(E[r])      # +1 long, −1 short
alpha = edge / σ        # cost-adjusted information ratio
```

`conf_floor` is the number of forecast standard deviations the *net* move must
exceed. At `conf_floor = 0.5`, a candidate trade must beat costs by at least
half a forecast-σ before any capital is committed. This single inequality is
what keeps the desk out of low-quality, high-uncertainty setups.

An optional **ensemble** combines several signals for the same symbol (e.g.
different horizons or model sizes) by an α-weighted vote, so consensus,
high-conviction setups size up while split votes stand aside.

---

## 3. Sizing: fractional Kelly

For a continuous bet whose return has mean `edge` and variance `σ²`, the
growth-optimal **Kelly fraction** of capital is

```
f* = edge / σ²
```

This is the Gaussian analogue of the discrete Kelly criterion
`f* = p − q/b`. Full Kelly maximises long-run log-wealth but is violently
volatile and extremely sensitive to estimation error - and our `edge`/`σ` are
*estimates* from a finite set of model samples. So Bibi always deploys a
fraction:

```
f = clip( kelly_fraction · f*, 0, f_max )
```

with `kelly_fraction` defaulting to `0.25` (quarter-Kelly). Two further caps
apply, and the binding one is recorded for transparency:

- **Per-trade R cap.** A position of fraction `f` stopped out at a fractional
  stop distance `d` loses `f · d` of equity. We bound that single-trade loss by
  `risk_per_trade_R`, giving `f ≤ risk_per_trade_R / d`.
- **Slot cap.** Equity is shared across at most `max_positions` concurrent
  trades, so `f ≤ 1 / max_positions`.

The final notional is `f · equity`, converted to base quantity at the entry
price.

---

## 4. Risk: R-multiples, ATR stops, and the kill-switch

Every trade is framed in **R**, its initial risk. Stops are placed using the
Average True Range so the protective distance adapts to each symbol's
volatility:

```
stop_distance = atr_stop_mult · ATR(atr_period)

long : stop = entry − stop_distance ,  target = entry + take_profit_R · stop_distance
short: stop = entry + stop_distance ,  target = entry − take_profit_R · stop_distance
```

One **R** is `stop_distance · quantity` in quote currency. P&L is reported in
R-multiples, which makes results comparable across symbols and sizes:

```
R-multiple = side · (exit − entry) · quantity / R
```

A **trailing** rule ratchets the stop in the trade's favour once price is at
least `+1R` onside, and never loosens it. A **daily-drawdown kill-switch**
tracks the intraday high-water mark per UTC day and halts new entries when
equity falls more than `max_daily_drawdown` below it, resetting at the next
UTC day.

---

## 5. Why research == production

The backtester (`backtest/`) calls the *same* `build_signal`, `kelly_size`, and
`RiskManager` code the live `Desk` uses; only the forecast source and the clock
differ. Forecasts are injected through a pluggable `forecast_fn`, so the entire
pipeline can be validated deterministically (a momentum stand-in) before
spending GPU cycles on real Kronos weights. This keeps the edge you measure in
research the edge you trade in production.
