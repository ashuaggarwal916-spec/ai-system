# Multi-stage build: compile the Rust execution engine, then ship it next to the Python desk.
FROM rust:1.82-slim AS engine
WORKDIR /build
COPY execution-engine/ ./execution-engine/
RUN cargo build --release --manifest-path execution-engine/Cargo.toml

FROM python:3.11-slim AS desk
WORKDIR /app

# Python deps first so the layer caches.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The compiled engine from the first stage.
COPY --from=engine /build/execution-engine/target/release/bibi-execution-engine /usr/local/bin/bibi-exec

# The desk itself.
COPY bibi/ ./bibi/
COPY backtest/ ./backtest/
COPY examples/ ./examples/
COPY pyproject.toml .

ENV BIBI_ENGINE_BIN=/usr/local/bin/bibi-exec
ENV PYTHONUNBUFFERED=1

# Paper mode by default. Live trading needs an explicit env flag (see scripts/run.sh).
ENTRYPOINT ["python", "-m", "bibi.desk"]
CMD ["--mode", "paper", "--symbols", "BTC/USDT,ETH/USDT,BNB/USDT", "--timeframe", "1h"]
