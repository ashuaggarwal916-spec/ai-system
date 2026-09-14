//! bibi-execution-engine
//!
//! Low-latency execution and order-routing layer for the bibi-desk trading
//! system. The Python desk shells out to the `bibi-exec` binary and speaks
//! line-delimited JSON over stdin/stdout. This crate is the routing core: it
//! takes an [`Order`], runs it through the pre-trade [`RiskGate`], slices it in
//! the [`Router`], simulates or places fills on a [`Venue`], and returns an
//! [`ExecReport`].
//!
//! Conventions follow `bibi/execution.py`: side is +1/-1 on the wire, money is
//! quote currency, costs and slippage are quoted in bps.

pub mod book;
pub mod order;
pub mod risk;
pub mod router;
pub mod venue;

use anyhow::Result;

use crate::book::BookConfig;
use crate::order::{ExecReport, Order};
use crate::risk::{RiskDecision, RiskGate, RiskLimits};
use crate::router::{Router, RouterConfig};
use crate::venue::{PaperVenue, Venue};

/// Top-level configuration assembled from CLI flags.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Paper (simulated) vs live routing. Live requires the `live` feature.
    pub paper: bool,
    /// Primary venue id (also used to tag paper fills).
    pub venue: String,
    pub risk: RiskLimits,
    pub book: BookConfig,
    pub router: RouterConfig,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            paper: true,
            venue: "paper".to_string(),
            risk: RiskLimits::default(),
            book: BookConfig::default(),
            router: RouterConfig::default(),
        }
    }
}

/// The execution engine. One per process. Holds the risk gate (stateful across
/// orders in a run) and the router (which owns the venues).
pub struct Engine {
    gate: RiskGate,
    router: Router,
}

impl Engine {
    /// Build an engine from config. In paper mode this wires a single
    /// [`PaperVenue`]. Live wiring is gated behind the `live` feature and a real
    /// client; see [`venue::LiveVenue`].
    pub fn new(cfg: EngineConfig) -> Self {
        let venues: Vec<Box<dyn Venue>> = if cfg.paper {
            vec![Box::new(PaperVenue::new(cfg.venue.clone(), cfg.book))]
        } else {
            // Live build would push a configured LiveVenue here. We still seed a
            // paper venue so the process is usable without secrets; the binary
            // warns when it does this.
            vec![Box::new(PaperVenue::new(cfg.venue.clone(), cfg.book))]
        };

        Engine {
            gate: RiskGate::new(cfg.risk),
            router: Router::new(cfg.router, venues),
        }
    }

    /// Flip the kill-switch. The desk calls this on a drawdown breach.
    pub fn set_kill_switch(&mut self, on: bool) {
        self.gate.set_kill_switch(on);
    }

    /// Process one order end to end: risk gate, then route, then aggregate.
    ///
    /// `mark` is the reference price for the order. When the order carries its
    /// own `price` (limit) that is used as the cap, but the mark is still the
    /// slippage and risk-band reference. Returns an [`ExecReport`] for every
    /// outcome, including rejects (it does not error on a rejected order).
    pub fn process(&mut self, order: &Order, mark: f64) -> Result<ExecReport> {
        match self.gate.check(order, mark) {
            RiskDecision::Reject(reason) => Ok(ExecReport::rejected(order, reason)),
            RiskDecision::Pass => {
                let fills = self.router.route(order, mark)?;
                let report = ExecReport::from_fills(order, fills);
                // Advance the running position by the filled notional so the
                // next order sees correct exposure.
                let filled_notional = report.avg_price * report.filled_qty;
                self.gate
                    .record_fill(&order.symbol, order.side.sign(), filled_notional);
                Ok(report)
            }
        }
    }

    /// Reference price for an order: explicit `price` field, else the caller
    /// must supply a mark. Helper for the binary, which falls back to the limit
    /// price when the desk omits a separate mark.
    pub fn reference_mark(order: &Order, fallback: Option<f64>) -> Option<f64> {
        order.price.or(fallback)
    }
}
