//! Pre-trade risk gate.
//!
//! Every order passes this gate before the router touches it. The gate is
//! intentionally dumb and fast: a handful of hard bounds that catch fat-finger
//! mistakes and runaway notional. Strategy-level R-multiple risk (ATR stops,
//! daily drawdown kill-switch) lives in the Python desk; this is the last line
//! of defence at the execution boundary.

use crate::order::Order;

/// Limits applied to every incoming order. Notional figures are quote currency.
#[derive(Debug, Clone, Copy)]
pub struct RiskLimits {
    /// Reject any single order whose notional exceeds this.
    pub max_notional: f64,
    /// Reject if the resulting absolute position notional would exceed this.
    pub max_position_notional: f64,
    /// Fat-finger band: reject a limit order whose price is more than this many
    /// bps away from the reference mark (catches a misplaced decimal point).
    pub max_price_band_bps: f64,
    /// Hard stop: when set, every order is rejected. The desk flips this on a
    /// drawdown breach or a manual halt.
    pub kill_switch: bool,
}

impl Default for RiskLimits {
    fn default() -> Self {
        RiskLimits {
            max_notional: 50_000.0,
            max_position_notional: 250_000.0,
            // 200 bps = 2% off the mark trips the fat-finger band.
            max_price_band_bps: 200.0,
            kill_switch: false,
        }
    }
}

/// Outcome of the gate: either pass, or reject with a human-readable reason.
#[derive(Debug, Clone)]
pub enum RiskDecision {
    Pass,
    Reject(String),
}

impl RiskDecision {
    pub fn is_pass(&self) -> bool {
        matches!(self, RiskDecision::Pass)
    }
}

/// Stateful gate. Tracks signed position notional per symbol so it can enforce
/// `max_position_notional` across a sequence of orders in one process run.
#[derive(Debug, Clone)]
pub struct RiskGate {
    limits: RiskLimits,
    /// Signed position notional per symbol (+ long, - short), in quote.
    positions: std::collections::HashMap<String, f64>,
}

impl RiskGate {
    pub fn new(limits: RiskLimits) -> Self {
        RiskGate {
            limits,
            positions: std::collections::HashMap::new(),
        }
    }

    pub fn limits(&self) -> &RiskLimits {
        &self.limits
    }

    pub fn set_kill_switch(&mut self, on: bool) {
        self.limits.kill_switch = on;
    }

    /// Run all checks for `order` against `mark` (the reference price). Read
    /// only: call [`RiskGate::record_fill`] after the order actually fills to
    /// move the running position.
    pub fn check(&self, order: &Order, mark: f64) -> RiskDecision {
        if self.limits.kill_switch {
            return RiskDecision::Reject("kill_switch engaged".into());
        }

        if !(order.quantity > 0.0) {
            return RiskDecision::Reject(format!("non-positive quantity {}", order.quantity));
        }
        if !mark.is_finite() || mark <= 0.0 {
            return RiskDecision::Reject(format!("invalid reference mark {mark}"));
        }

        // Fat-finger band on limit price. A buy limit far above the mark or a
        // sell limit far below it is almost always a decimal-point slip.
        if let (crate::order::OrderType::Limit, Some(px)) = (order.order_type, order.price) {
            let dev_bps = (px - mark).abs() / mark * 1e4;
            if dev_bps > self.limits.max_price_band_bps {
                return RiskDecision::Reject(format!(
                    "limit price {px} is {dev_bps:.0} bps off mark {mark}, band is {} bps",
                    self.limits.max_price_band_bps
                ));
            }
        }

        // Single-order notional cap. Use limit price if present, else the mark.
        let ref_px = order.price.unwrap_or(mark);
        let order_notional = ref_px * order.quantity;
        if order_notional > self.limits.max_notional {
            return RiskDecision::Reject(format!(
                "order notional {order_notional:.2} exceeds max {:.2}",
                self.limits.max_notional
            ));
        }

        // Projected position cap. Add the signed order to the running position
        // and check the resulting absolute notional.
        let current = self.positions.get(&order.symbol).copied().unwrap_or(0.0);
        let projected = current + order.side.sign() * order_notional;
        if projected.abs() > self.limits.max_position_notional {
            return RiskDecision::Reject(format!(
                "projected position {:.2} for {} exceeds max {:.2}",
                projected.abs(),
                order.symbol,
                self.limits.max_position_notional
            ));
        }

        RiskDecision::Pass
    }

    /// Move the running position by a filled notional. Call once per parent
    /// order after fills land so subsequent orders see the new exposure.
    pub fn record_fill(&mut self, symbol: &str, side_sign: f64, filled_notional: f64) {
        *self.positions.entry(symbol.to_string()).or_insert(0.0) += side_sign * filled_notional;
    }

    /// Current signed position notional for a symbol (testing/introspection).
    pub fn position_notional(&self, symbol: &str) -> f64 {
        self.positions.get(symbol).copied().unwrap_or(0.0)
    }
}
