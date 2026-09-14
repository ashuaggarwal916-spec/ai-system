# bibi-execution-engine

The low-latency execution and order-routing layer for **bibi-desk**.

The Python desk does signal generation, sizing and R-multiple risk. When it
decides to trade it does not place the order itself. It shells out to this Rust
binary, `bibi-exec`, which owns the hot path: a pre-trade risk gate, a smart
order router (market, limit, TWAP, iceberg), and a deterministic paper fill
simulator. The split keeps the slow, model-heavy Python out of the order path
while keeping a single source of truth for fills and slippage.

Money is quote currency (USDT). Quantities are base asset. Costs and slippage
are quoted in basis points (1 bps = 0.01%), matching `bibi/execution.py`.

## How Python calls it

The desk spawns the binary once and keeps it alive, writing one JSON order per
line on stdin and reading one JSON exec report per line on stdout, in order.

```python
import json, subprocess

proc = subprocess.Popen(
    ["bibi-exec", "--paper", "--venue", "paper", "--max-notional", "50000"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)

order = {
    "id": "o-1", "symbol": "BTC/USDT", "side": "Buy",
    "type": "market", "quantity": 0.5, "mark": 65000.0,
}
proc.stdin.write(json.dumps(order) + "\n")
proc.stdin.flush()
report = json.loads(proc.stdout.readline())
print(report["status"], report["avg_price"], report["slippage_bps"])
```

stdout is a clean machine-readable stream. Warnings and diagnostics go to
stderr.

## JSON protocol

### Order line (stdin)

| field         | type            | required | notes                                              |
|---------------|-----------------|----------|----------------------------------------------------|
| `id`          | string          | yes      | client order id. TWAP children derive `id#0`, ...  |
| `symbol`      | string          | yes      | e.g. `BTC/USDT`                                     |
| `side`        | `"Buy"`/`"Sell"`| yes      | direction                                          |
| `type`        | enum            | yes      | `market`, `limit`, `twap`, `iceberg`               |
| `quantity`    | float           | yes      | base asset, positive                               |
| `price`       | float           | for limit| limit cap, or reference mark if `mark` is omitted  |
| `mark`        | float           | yes*     | reference price for slippage and risk band         |
| `tif`         | enum            | no       | `GTC` (default), `IOC`, `FOK`                       |
| `slices`      | int             | no       | TWAP: number of even child clips                   |
| `display_qty` | float           | no       | iceberg: visible clip per refill                   |
| `venue`       | string          | no       | route override; otherwise router picks             |

\* Either `mark` or `price` must be present. For a limit order `price` is the
cap and `mark` is the slippage/risk reference; if `mark` is omitted the limit
`price` is used as the reference too.

### Control line (stdin)

```json
{"control": "kill", "on": true}
```

Toggles the kill-switch. While engaged every order is rejected.

### Exec report (stdout)

| field          | type   | notes                                              |
|----------------|--------|----------------------------------------------------|
| `id`           | string | echoes the parent order id                         |
| `symbol`       | string |                                                    |
| `status`       | enum   | `filled`, `partially_filled`, `cancelled`, `rejected` |
| `filled_qty`   | float  | base filled across all children                    |
| `leaves_qty`   | float  | unfilled remainder                                 |
| `avg_price`    | float  | quantity-weighted average fill price               |
| `fees`         | float  | total quote-currency fees                          |
| `slippage_bps` | float  | notional-weighted realised slippage, bps           |
| `fills`        | array  | one entry per child placement                      |
| `reason`       | string | set on reject/cancel, omitted otherwise            |

## Order types

- **market**: one clip, fills against the book from the touch, walks levels.
- **limit**: one clip, fills only at or better than the limit price.
- **twap**: parent split into N even children placed over N intervals. The desk
  advances the `mark` between calls. Rounding remainder rides the last child.
- **iceberg**: shows a small `display_qty` clip, refills until done or the book
  stops crossing.

## Risk gate

Runs before the router on every order. Hard, fast bounds:

- `--max-notional`: single-order notional cap.
- `--max-position`: cap on resulting absolute position notional (tracked across
  the run).
- `--price-band-bps`: fat-finger band on limit price vs mark (catches a
  misplaced decimal point).
- kill-switch: blocks all orders when engaged.

Strategy-level risk (ATR stops, R-multiple targets, daily-drawdown halt) stays
in the Python desk. This gate is the last line of defence at the boundary.

## Venues

- `PaperVenue`: deterministic simulator over a synthetic book. Default.
- `LiveVenue`: documented stub. A real build (`--features live`, with tokio)
  would sign and POST orders to an exchange REST/ws and fold the response into
  a fill. As shipped it refuses to route so a misconfigured desk fails loud.

## Build and run

```sh
cargo build --release            # paper engine, no network deps
cargo test                       # book matcher + risk gate tests
cargo build --release --features live   # pulls tokio for the live stub

# smoke test from a shell
printf '%s\n' '{"id":"o-1","symbol":"BTC/USDT","side":"Buy","type":"market","quantity":0.5,"mark":65000.0}' \
  | ./target/release/bibi-exec --paper
```

## CLI flags

| flag                  | default | meaning                                  |
|-----------------------|---------|------------------------------------------|
| `--paper`             | true    | simulated routing                        |
| `--venue <id>`        | paper   | primary venue id / paper fill tag        |
| `--max-notional <n>`  | 50000   | single-order notional cap (quote)        |
| `--max-position <n>`  | 250000  | absolute position notional cap (quote)   |
| `--price-band-bps <n>`| 200     | fat-finger band on limit price           |
| `--fee-bps <n>`       | 10      | per-leg fee applied by the paper venue   |
| `--twap-slices <n>`   | 10      | default TWAP slice count                 |

## Layout

```
Cargo.toml          crate manifest, deps, release profile
src/main.rs         bibi-exec CLI: stdin/stdout JSON loop
src/lib.rs          Engine: wires risk + router, process(order) -> report
src/order.rs        Order, Side, OrderType, Fill, ExecReport wire types
src/book.rs         synthetic order book + deterministic fill simulator
src/router.rs       smart router: market/limit/TWAP/iceberg slicing
src/risk.rs         pre-trade gate: notional, position, band, kill-switch
src/venue.rs        Venue trait, PaperVenue, LiveVenue stub
tests/              book matcher and risk gate tests
```
