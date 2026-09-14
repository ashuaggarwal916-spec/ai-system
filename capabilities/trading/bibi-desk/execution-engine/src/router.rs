//! Smart order router.
//!
//! Takes a parent [`Order`], decides how to slice it, and walks the slices
//! across one or more venues, collecting fills. Order types:
//!
//! * Market / Limit: a single clip straight to the chosen venue.
//! * TWAP: split the parent into N even child clips placed over N intervals.
//!   In a real deployment the children would be spaced in wall-clock time; here
//!   they are placed back to back against the same mark (the desk advances the
//!   mark between calls), which keeps paper runs deterministic.
//! * Iceberg: place a small visible clip, refill until the parent is done or
//!   the book stops crossing (for a limit iceberg).

use anyhow::Result;

use crate::order::{Fill, Order, OrderType};
use crate::venue::Venue;

/// Router knobs.
#[derive(Debug, Clone, Copy)]
pub struct RouterConfig {
    /// Default slice count for a TWAP that did not specify `slices`.
    pub default_twap_slices: usize,
    /// Default iceberg display clip as a fraction of parent quantity, used when
    /// the order did not set `display_qty`.
    pub default_iceberg_frac: f64,
    /// Safety cap on refill iterations so a pathological order cannot spin.
    pub max_child_orders: usize,
}

impl Default for RouterConfig {
    fn default() -> Self {
        RouterConfig {
            default_twap_slices: 10,
            default_iceberg_frac: 0.1,
            max_child_orders: 1_000,
        }
    }
}

/// Routes parent orders into child clips against a set of venues.
pub struct Router {
    cfg: RouterConfig,
    venues: Vec<Box<dyn Venue>>,
}

impl Router {
    pub fn new(cfg: RouterConfig, venues: Vec<Box<dyn Venue>>) -> Self {
        assert!(!venues.is_empty(), "router needs at least one venue");
        Router { cfg, venues }
    }

    /// Pick a venue for an order. If the order names one we honour it (by name),
    /// otherwise we use the first configured venue. A fuller implementation
    /// would score venues by quoted depth and fee; the hook is here.
    fn select_venue(&mut self, order: &Order) -> &mut Box<dyn Venue> {
        let idx = match &order.venue {
            Some(want) => self
                .venues
                .iter()
                .position(|v| v.name() == want)
                .unwrap_or(0),
            None => 0,
        };
        &mut self.venues[idx]
    }

    /// Route a parent order to completion, returning every child fill. `mark` is
    /// the reference price the desk supplies for this order.
    pub fn route(&mut self, order: &Order, mark: f64) -> Result<Vec<Fill>> {
        match order.order_type {
            OrderType::Market | OrderType::Limit => self.route_single(order, mark),
            OrderType::Twap => self.route_twap(order, mark),
            OrderType::Iceberg => self.route_iceberg(order, mark),
        }
    }

    /// One clip, one venue.
    fn route_single(&mut self, order: &Order, mark: f64) -> Result<Vec<Fill>> {
        let venue = self.select_venue(order);
        let fill = venue.execute_clip(order, order.quantity, mark)?;
        Ok(fill.into_iter().collect())
    }

    /// Even N-way slice. Each child carries an equal share of the parent
    /// quantity; any rounding remainder rides on the final child.
    fn route_twap(&mut self, order: &Order, mark: f64) -> Result<Vec<Fill>> {
        let n = order
            .slices
            .unwrap_or(self.cfg.default_twap_slices)
            .max(1)
            .min(self.cfg.max_child_orders);
        let clip = order.quantity / n as f64;

        let mut fills = Vec::with_capacity(n);
        let mut placed = 0.0;
        for i in 0..n {
            // Last child mops up the rounding remainder so totals tie out.
            let this_clip = if i == n - 1 {
                order.quantity - placed
            } else {
                clip
            };
            placed += this_clip;

            let venue = self.select_venue(order);
            if let Some(f) = venue.execute_clip(order, this_clip, mark)? {
                fills.push(f);
            }
        }
        Ok(fills)
    }

    /// Iceberg: repeatedly place a small display clip until the parent is filled
    /// or the book stops crossing. For a limit iceberg, a non-crossing clip
    /// returns no fill and we stop (no point hammering an away price).
    fn route_iceberg(&mut self, order: &Order, mark: f64) -> Result<Vec<Fill>> {
        let display = order
            .display_qty
            .filter(|d| *d > 0.0)
            .unwrap_or(order.quantity * self.cfg.default_iceberg_frac)
            .min(order.quantity);
        let display = if display <= 0.0 { order.quantity } else { display };

        let mut fills = Vec::new();
        let mut remaining = order.quantity;
        let mut iters = 0usize;

        while remaining > 1e-12 && iters < self.cfg.max_child_orders {
            iters += 1;
            let clip = remaining.min(display);
            let venue = self.select_venue(order);
            match venue.execute_clip(order, clip, mark)? {
                Some(f) => {
                    remaining -= f.quantity;
                    fills.push(f);
                    // If a clip came back short of its display size the book is
                    // drained at our price; stop refilling.
                    if remaining > 1e-12 && fills.last().map(|x| x.quantity).unwrap_or(0.0) + 1e-9 < clip {
                        break;
                    }
                }
                None => break, // limit no longer crosses
            }
        }
        Ok(fills)
    }
}
