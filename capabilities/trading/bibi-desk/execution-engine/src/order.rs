//! Order, fill and execution-report types.
//!
//! These are the wire types shared with the Python desk. Conventions match
//! `bibi/execution.py`:
//!
//! * `side` is +1 buy / -1 sell on the wire, mapped to the [`Side`] enum here.
//! * all money is quote currency (USDT), quantities are base asset.
//! * slippage and fees are quoted in basis points (1 bps = 0.01%).

use serde::{Deserialize, Serialize};

/// Trade direction. Serialises as the integer +1 / -1 the Python desk sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    /// Signed multiplier (+1 buy, -1 sell). Used everywhere we price slippage
    /// or accumulate signed position.
    pub fn sign(self) -> f64 {
        match self {
            Side::Buy => 1.0,
            Side::Sell => -1.0,
        }
    }

    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

/// Order style. Market and Limit are atomic; Twap and Iceberg are parent orders
/// the router slices into children before they ever reach a venue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderType {
    Market,
    Limit,
    /// Time-weighted average price: split notional evenly over N intervals.
    Twap,
    /// Show only a small "display" clip at a time, refill as it fills.
    Iceberg,
}

/// Time-in-force for resting (limit) orders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TimeInForce {
    /// Good til cancelled.
    Gtc,
    /// Immediate-or-cancel: take what is available now, cancel the rest.
    Ioc,
    /// Fill-or-kill: fill the whole clip immediately or cancel all.
    Fok,
}

impl Default for TimeInForce {
    fn default() -> Self {
        TimeInForce::Gtc
    }
}

/// Stable client order id. The desk supplies one per parent order; child
/// slices derive theirs by suffixing `#<n>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OrderId(pub String);

impl OrderId {
    pub fn child(&self, n: usize) -> OrderId {
        OrderId(format!("{}#{}", self.0, n))
    }
}

impl std::fmt::Display for OrderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// An order request as received from the Python desk.
///
/// `price` is required for [`OrderType::Limit`] and is otherwise the reference
/// mark the paper venue fills around (the desk passes the next bar's open).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: OrderId,
    pub symbol: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    /// Base-asset quantity. Always positive; direction lives in `side`.
    pub quantity: f64,
    /// Limit price, or reference mark for market/twap/iceberg fills.
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub tif: TimeInForce,
    /// TWAP only: number of even slices to spread the parent over.
    #[serde(default)]
    pub slices: Option<usize>,
    /// Iceberg only: visible clip size per refill (base asset).
    #[serde(default)]
    pub display_qty: Option<f64>,
    /// Optional venue override. When absent the router picks one.
    #[serde(default)]
    pub venue: Option<String>,
}

impl Order {
    /// Notional in quote currency at the order's reference price (0 if none).
    pub fn notional(&self) -> f64 {
        self.price.unwrap_or(0.0) * self.quantity
    }
}

/// A single execution event. Mirrors `bibi.execution.Fill`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub symbol: String,
    pub side: Side,
    pub price: f64,
    pub quantity: f64,
    /// Quote-currency fee charged on this leg.
    pub fee: f64,
    /// Venue that produced the fill.
    pub venue: String,
    /// Realised slippage vs the order's reference price, in bps. Positive means
    /// the fill was worse than reference for the side taken.
    pub slippage_bps: f64,
}

impl Fill {
    pub fn notional(&self) -> f64 {
        self.price * self.quantity
    }
}

/// Terminal status of an order after the engine has processed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecStatus {
    /// Fully filled.
    Filled,
    /// Some quantity filled, remainder cancelled (IOC, or book ran dry).
    PartiallyFilled,
    /// Nothing filled and the order was cancelled (FOK miss, no liquidity).
    Cancelled,
    /// Blocked by the pre-trade risk gate. See `reason`.
    Rejected,
}

/// The report the engine writes back to the desk for every order it sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecReport {
    pub id: OrderId,
    pub symbol: String,
    pub status: ExecStatus,
    /// Base quantity filled across all child fills.
    pub filled_qty: f64,
    /// Quantity quoted on the parent but not filled.
    pub leaves_qty: f64,
    /// Quantity-weighted average fill price (0 when nothing filled).
    pub avg_price: f64,
    /// Total quote-currency fees across all child fills.
    pub fees: f64,
    /// Notional-weighted realised slippage in bps across all fills.
    pub slippage_bps: f64,
    /// One fill per child placement (a TWAP of N slices yields up to N fills).
    pub fills: Vec<Fill>,
    /// Reason string, set on Rejected / Cancelled, otherwise empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
}

impl ExecReport {
    /// Build a rejected report from a risk-gate reason.
    pub fn rejected(order: &Order, reason: impl Into<String>) -> Self {
        ExecReport {
            id: order.id.clone(),
            symbol: order.symbol.clone(),
            status: ExecStatus::Rejected,
            filled_qty: 0.0,
            leaves_qty: order.quantity,
            avg_price: 0.0,
            fees: 0.0,
            slippage_bps: 0.0,
            fills: Vec::new(),
            reason: reason.into(),
        }
    }

    /// Aggregate a set of child fills into a parent report. `requested` is the
    /// parent quantity used to compute leaves_qty.
    pub fn from_fills(order: &Order, fills: Vec<Fill>) -> Self {
        // `+ 0.0` normalises a -0.0 that an empty sum can produce, so a no-fill
        // report serialises clean zeros.
        let filled_qty: f64 = fills.iter().map(|f| f.quantity).sum::<f64>() + 0.0;
        let fees: f64 = fills.iter().map(|f| f.fee).sum::<f64>() + 0.0;
        let notional: f64 = fills.iter().map(|f| f.notional()).sum();
        let avg_price = if filled_qty > 0.0 {
            notional / filled_qty
        } else {
            0.0
        };
        // Notional-weight the per-fill slippage so big clips dominate the number.
        let slippage_bps = if notional > 0.0 {
            fills.iter().map(|f| f.slippage_bps * f.notional()).sum::<f64>() / notional
        } else {
            0.0
        };
        let leaves = (order.quantity - filled_qty).max(0.0);
        let status = if filled_qty <= 0.0 {
            ExecStatus::Cancelled
        } else if leaves > 1e-12 {
            ExecStatus::PartiallyFilled
        } else {
            ExecStatus::Filled
        };
        ExecReport {
            id: order.id.clone(),
            symbol: order.symbol.clone(),
            status,
            filled_qty,
            leaves_qty: leaves,
            avg_price,
            fees,
            slippage_bps,
            fills,
            reason: String::new(),
        }
    }
}
