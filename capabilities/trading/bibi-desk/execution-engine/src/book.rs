//! Local limit order book plus a deterministic paper fill simulator.
//!
//! The book holds price levels per side. In paper mode we do not have a real
//! venue feed, so the simulator seeds a synthetic book around a reference mark
//! using a configurable half-spread and per-level depth, then walks it to
//! produce realistic partial fills and slippage. Everything is deterministic:
//! the same order against the same mark always fills the same way, which keeps
//! backtests reproducible.

use crate::order::{Fill, Order, Side};

/// One resting price level: a price and the base-asset size available there.
#[derive(Debug, Clone, Copy)]
pub struct Level {
    pub price: f64,
    pub size: f64,
}

/// Tunables for the synthetic book and the fill model. All bps fields follow
/// the desk convention (1 bps = 0.01%).
#[derive(Debug, Clone, Copy)]
pub struct BookConfig {
    /// Half the touch spread, in bps, applied either side of the mark.
    pub half_spread_bps: f64,
    /// Gap between synthetic levels, in bps of the mark.
    pub tick_bps: f64,
    /// Base-asset size resting at each synthetic level.
    pub level_depth: f64,
    /// Number of levels generated per side.
    pub levels: usize,
    /// Per-leg fee in bps (round-trip cost halved, matching PaperBroker).
    pub fee_bps: f64,
}

impl Default for BookConfig {
    fn default() -> Self {
        // Liquid major-pair defaults: 1 bps touch, 0.5 bps ticks, deep enough
        // that a normal clip walks only a couple of levels.
        BookConfig {
            half_spread_bps: 1.0,
            tick_bps: 0.5,
            level_depth: 5.0,
            levels: 50,
            fee_bps: 10.0,
        }
    }
}

/// A two-sided book around a mark. `bids` descend in price, `asks` ascend.
#[derive(Debug, Clone)]
pub struct OrderBook {
    pub mark: f64,
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
    cfg: BookConfig,
}

impl OrderBook {
    /// Build a synthetic book around `mark`. Used by the paper venue when no
    /// real depth is available.
    pub fn synthetic(mark: f64, cfg: BookConfig) -> Self {
        let half = mark * cfg.half_spread_bps / 1e4;
        let tick = mark * cfg.tick_bps / 1e4;
        let best_ask = mark + half;
        let best_bid = mark - half;

        let mut asks = Vec::with_capacity(cfg.levels);
        let mut bids = Vec::with_capacity(cfg.levels);
        for i in 0..cfg.levels {
            asks.push(Level {
                price: best_ask + tick * i as f64,
                size: cfg.level_depth,
            });
            bids.push(Level {
                price: best_bid - tick * i as f64,
                size: cfg.level_depth,
            });
        }
        OrderBook {
            mark,
            bids,
            asks,
            cfg,
        }
    }

    /// Best price available to a taker on `side` (a buyer lifts the ask).
    pub fn best(&self, side: Side) -> Option<f64> {
        match side {
            Side::Buy => self.asks.first().map(|l| l.price),
            Side::Sell => self.bids.first().map(|l| l.price),
        }
    }

    /// The side of the book a taker consumes.
    fn taker_levels(&mut self, side: Side) -> &mut Vec<Level> {
        match side {
            Side::Buy => &mut self.asks,
            Side::Sell => &mut self.bids,
        }
    }

    /// Walk the book to fill up to `qty` at or better than `limit` (None = no
    /// price cap, i.e. a market order). Consumes liquidity from the book and
    /// returns one aggregated [`Fill`] (or `None` if nothing matched).
    ///
    /// `reference` is the order's reference mark, used to compute slippage.
    pub fn take(
        &mut self,
        symbol: &str,
        side: Side,
        qty: f64,
        limit: Option<f64>,
        reference: f64,
        venue: &str,
    ) -> Option<Fill> {
        let fee_bps = self.cfg.fee_bps;
        let levels = self.taker_levels(side);

        let mut remaining = qty;
        let mut filled = 0.0;
        let mut notional = 0.0;
        let mut consumed = 0usize;

        for level in levels.iter_mut() {
            if remaining <= 1e-12 {
                break;
            }
            // Respect a limit: a buyer rejects asks above the limit, a seller
            // rejects bids below it.
            if let Some(lim) = limit {
                let crosses = match side {
                    Side::Buy => level.price <= lim + 1e-12,
                    Side::Sell => level.price >= lim - 1e-12,
                };
                if !crosses {
                    break;
                }
            }
            let take = remaining.min(level.size);
            filled += take;
            notional += take * level.price;
            remaining -= take;
            level.size -= take;
            if level.size <= 1e-12 {
                consumed += 1;
            }
        }

        // Drop fully consumed levels from the front of the book.
        if consumed > 0 {
            levels.drain(0..consumed);
        }

        if filled <= 1e-12 {
            return None;
        }

        let avg_price = notional / filled;
        // Slippage: how much worse than reference the average fill was, in the
        // direction of the trade. A buyer paying above reference is positive.
        let slippage_bps = side.sign() * (avg_price - reference) / reference * 1e4;
        // Single-leg fee, mirroring PaperBroker (round-trip cost halved).
        let fee = filled * avg_price * (fee_bps / 1e4) / 2.0;

        Some(Fill {
            symbol: symbol.to_string(),
            side,
            price: avg_price,
            quantity: filled,
            fee,
            venue: venue.to_string(),
            slippage_bps,
        })
    }
}

/// Convenience wrapper: simulate a single clip against a fresh synthetic book.
/// The router calls this once per child slice.
pub fn simulate_clip(order: &Order, clip_qty: f64, mark: f64, cfg: BookConfig, venue: &str) -> Option<Fill> {
    let mut book = OrderBook::synthetic(mark, cfg);
    let limit = match order.order_type {
        crate::order::OrderType::Limit => order.price,
        _ => None,
    };
    book.take(&order.symbol, order.side, clip_qty, limit, mark, venue)
}
