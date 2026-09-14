#!/usr/bin/env bash
# Start the desk loop. Defaults to paper mode so nothing hits a live venue by accident.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-paper}"
SYMBOLS="${SYMBOLS:-BTC/USDT,ETH/USDT,BNB/USDT}"
TIMEFRAME="${TIMEFRAME:-1h}"
MODEL="${MODEL:-NeoQuasar/Kronos-small}"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

if [ "$MODE" = "live" ]; then
  echo "[run] LIVE mode requested. Refusing unless BIBI_I_KNOW_WHAT_IM_DOING=1 is set."
  [ "${BIBI_I_KNOW_WHAT_IM_DOING:-0}" = "1" ] || exit 1
fi

echo "[run] mode=$MODE symbols=$SYMBOLS tf=$TIMEFRAME model=$MODEL"
exec python -m bibi.desk \
  --mode "$MODE" \
  --symbols "$SYMBOLS" \
  --timeframe "$TIMEFRAME" \
  --model "$MODEL"
