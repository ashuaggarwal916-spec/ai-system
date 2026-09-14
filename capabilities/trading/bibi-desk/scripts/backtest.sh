#!/usr/bin/env bash
# Run a backtest over a CSV of OHLCV bars and print the metrics table.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA="${1:-data/BTCUSDT_1h.csv}"
MODEL="${MODEL:-NeoQuasar/Kronos-small}"
FEE_BPS="${FEE_BPS:-10}"
SLIP_BPS="${SLIP_BPS:-5}"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

if [ ! -f "$DATA" ]; then
  echo "[backtest] no data file at $DATA"
  echo "[backtest] pull bars first, for example:"
  echo "  python -m bibi.data --symbol BTC/USDT --timeframe 1h --limit 8000 --out $DATA"
  exit 1
fi

echo "[backtest] data=$DATA model=$MODEL fee=${FEE_BPS}bps slip=${SLIP_BPS}bps"
python -m backtest.run \
  --data "$DATA" \
  --model "$MODEL" \
  --fee-bps "$FEE_BPS" \
  --slippage-bps "$SLIP_BPS"
