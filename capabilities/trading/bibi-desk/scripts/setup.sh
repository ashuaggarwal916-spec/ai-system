#!/usr/bin/env bash
# Set up a local dev environment for the Bibi desk.
# Creates a venv, installs the Python deps, and builds the Rust execution engine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${PYTHON:-python3}"
VENV="${VENV:-.venv}"

echo "[setup] python env -> $VENV"
"$PY" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "[setup] installing python deps"
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

if command -v cargo >/dev/null 2>&1; then
  echo "[setup] building rust execution engine (release)"
  cargo build --release --manifest-path execution-engine/Cargo.toml
  echo "[setup] engine binary -> execution-engine/target/release/bibi-execution-engine"
else
  echo "[setup] cargo not found, skipping the rust engine (paper mode falls back to the python sim)"
fi

echo "[setup] done. activate with: source $VENV/bin/activate"
