.PHONY: setup install engine test test-rust lint backtest run paper docker clean

PY ?= python3
ENGINE_MANIFEST = execution-engine/Cargo.toml

setup:
	bash scripts/setup.sh

install:
	$(PY) -m pip install -r requirements.txt

engine:
	cargo build --release --manifest-path $(ENGINE_MANIFEST)

test:
	$(PY) -m pytest -q

test-rust:
	cargo test --manifest-path $(ENGINE_MANIFEST)

lint:
	$(PY) -m ruff check bibi backtest || true
	cargo clippy --manifest-path $(ENGINE_MANIFEST) || true

backtest:
	bash scripts/backtest.sh

run paper:
	bash scripts/run.sh paper

docker:
	docker compose build

clean:
	rm -rf .pytest_cache **/__pycache__ execution-engine/target
