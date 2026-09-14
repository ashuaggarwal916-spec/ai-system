//! `bibi-exec` binary.
//!
//! The Python desk (bibi-desk) launches this process and streams orders to it
//! as line-delimited JSON on stdin. For each line the engine emits exactly one
//! line-delimited JSON [`ExecReport`] on stdout, in the same order. Diagnostics
//! and warnings go to stderr so stdout stays a clean machine-readable stream.
//!
//! Protocol (one JSON object per line on stdin):
//!
//! ```json
//! {"id":"o-1","symbol":"BTC/USDT","side":"Buy","type":"market","quantity":0.5,"mark":65000.0}
//! ```
//!
//! `mark` is the reference price the desk passes (next bar's open in backtest).
//! Limit orders may instead carry `price`; if both are present `price` is the
//! cap and `mark` is the slippage/risk reference. A control line is also
//! accepted: `{"control":"kill","on":true}` toggles the kill-switch.

use std::io::{self, BufRead, Write};

use anyhow::{Context, Result};
use clap::Parser;
use serde::Deserialize;

use bibi_execution_engine::book::BookConfig;
use bibi_execution_engine::order::Order;
use bibi_execution_engine::risk::RiskLimits;
use bibi_execution_engine::router::RouterConfig;
use bibi_execution_engine::{Engine, EngineConfig};

/// Low-latency execution engine for bibi-desk. Reads orders as line-delimited
/// JSON on stdin, writes exec reports as line-delimited JSON on stdout.
#[derive(Debug, Parser)]
#[command(name = "bibi-exec", version, about)]
struct Cli {
    /// Paper (simulated) mode. This is the default; live needs the `live`
    /// feature and real credentials.
    #[arg(long, default_value_t = true)]
    paper: bool,

    /// Primary venue id. Tags paper fills and is the default routing target.
    #[arg(long, default_value = "paper")]
    venue: String,

    /// Reject any single order whose notional exceeds this (quote currency).
    #[arg(long, default_value_t = 50_000.0)]
    max_notional: f64,

    /// Reject if resulting absolute position notional would exceed this.
    #[arg(long, default_value_t = 250_000.0)]
    max_position: f64,

    /// Fat-finger band on limit price, in bps off the mark.
    #[arg(long, default_value_t = 200.0)]
    price_band_bps: f64,

    /// Per-leg fee in bps applied by the paper venue.
    #[arg(long, default_value_t = 10.0)]
    fee_bps: f64,

    /// Default TWAP slice count when an order does not set `slices`.
    #[arg(long, default_value_t = 10)]
    twap_slices: usize,
}

/// What a single stdin line can be: an order, or a control message.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Line {
    Control(Control),
    Order(OrderLine),
}

#[derive(Debug, Deserialize)]
struct Control {
    control: String,
    #[serde(default)]
    on: bool,
}

/// An order line, with the optional reference `mark` that lives at the wire
/// layer (the [`Order`] type itself does not carry it).
#[derive(Debug, Deserialize)]
struct OrderLine {
    #[serde(flatten)]
    order: Order,
    #[serde(default)]
    mark: Option<f64>,
}

fn build_config(cli: &Cli) -> EngineConfig {
    let mut book = BookConfig::default();
    book.fee_bps = cli.fee_bps;

    let mut router = RouterConfig::default();
    router.default_twap_slices = cli.twap_slices;

    let risk = RiskLimits {
        max_notional: cli.max_notional,
        max_position_notional: cli.max_position,
        max_price_band_bps: cli.price_band_bps,
        kill_switch: false,
    };

    EngineConfig {
        paper: cli.paper,
        venue: cli.venue.clone(),
        risk,
        book,
        router,
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = build_config(&cli);
    if !cli.paper {
        eprintln!(
            "warning: live mode requested but this build routes to the paper venue (rebuild --features live)"
        );
    }
    let mut engine = Engine::new(cfg);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for (lineno, line) in stdin.lock().lines().enumerate() {
        let line = line.with_context(|| format!("reading stdin line {}", lineno + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed: Line = match serde_json::from_str(trimmed) {
            Ok(l) => l,
            Err(e) => {
                // Bad input is per-line recoverable: log and skip, do not kill
                // the stream. Emit a parse-error marker so the desk can count it.
                eprintln!("parse error on line {}: {e}", lineno + 1);
                writeln!(out, "{}", parse_error_json(lineno + 1, &e))?;
                out.flush()?;
                continue;
            }
        };

        match parsed {
            Line::Control(ctrl) => {
                if ctrl.control == "kill" {
                    engine.set_kill_switch(ctrl.on);
                    eprintln!("kill-switch set to {}", ctrl.on);
                } else {
                    eprintln!("unknown control '{}' on line {}", ctrl.control, lineno + 1);
                }
            }
            Line::Order(ol) => {
                let mark = match Engine::reference_mark(&ol.order, ol.mark) {
                    Some(m) => m,
                    None => {
                        eprintln!("order {} has no price or mark; skipping", ol.order.id);
                        continue;
                    }
                };
                let report = engine.process(&ol.order, mark)?;
                serde_json::to_writer(&mut out, &report)
                    .context("serialising exec report")?;
                out.write_all(b"\n")?;
                // Flush per line: the desk reads synchronously and expects the
                // report before it sends the next order.
                out.flush()?;
            }
        }
    }

    Ok(())
}

/// Minimal JSON marker emitted when a line fails to parse, so the desk's reader
/// always gets one line back per input line.
fn parse_error_json(lineno: usize, err: &serde_json::Error) -> String {
    format!(
        "{{\"status\":\"rejected\",\"reason\":\"parse error line {}: {}\"}}",
        lineno,
        err.to_string().replace('"', "'")
    )
}
