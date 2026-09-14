//! Venue abstraction.
//!
//! A [`Venue`] is anything that can take a clip of an order and return a fill.
//! [`PaperVenue`] simulates against a synthetic book and is the default.
//! [`LiveVenue`] is a documented stub showing where a real REST/ws integration
//! would slot in; it never reaches out over the network in this build.

use anyhow::{bail, Result};

use crate::book::{simulate_clip, BookConfig};
use crate::order::{Fill, Order};

/// Anything that can execute a single clip (child slice) of an order.
///
/// Implementations are expected to be stateless from the router's point of
/// view: position and cash accounting live in the desk, the venue only reports
/// fills.
pub trait Venue {
    /// Human-readable venue id used to tag fills and for venue selection.
    fn name(&self) -> &str;

    /// Execute up to `clip_qty` of `order` against this venue at the given
    /// reference `mark`. Returns `Ok(None)` when nothing filled (no crossing
    /// liquidity), `Err` only on a genuine venue fault.
    fn execute_clip(&mut self, order: &Order, clip_qty: f64, mark: f64) -> Result<Option<Fill>>;
}

/// Deterministic paper venue backed by the synthetic book in `book.rs`.
pub struct PaperVenue {
    name: String,
    cfg: BookConfig,
}

impl PaperVenue {
    pub fn new(name: impl Into<String>, cfg: BookConfig) -> Self {
        PaperVenue {
            name: name.into(),
            cfg,
        }
    }
}

impl Venue for PaperVenue {
    fn name(&self) -> &str {
        &self.name
    }

    fn execute_clip(&mut self, order: &Order, clip_qty: f64, mark: f64) -> Result<Option<Fill>> {
        if clip_qty <= 0.0 {
            bail!("clip quantity must be positive, got {clip_qty}");
        }
        if mark <= 0.0 {
            bail!("reference mark must be positive, got {mark}");
        }
        Ok(simulate_clip(order, clip_qty, mark, self.cfg, &self.name))
    }
}

/// Live venue stub.
///
/// In a real build this would hold an authenticated REST/ws client (built under
/// the `live` feature with tokio) and translate a clip into an exchange order,
/// poll for the fill, and map the response back to a [`Fill`]. We keep it as a
/// stub so the engine compiles and behaves identically in CI without secrets or
/// network access. Any attempt to route here returns an error rather than
/// silently pretending to trade.
pub struct LiveVenue {
    name: String,
    #[allow(dead_code)]
    base_url: String,
    #[allow(dead_code)]
    api_key: String,
}

impl LiveVenue {
    /// Construct a live venue handle. Credentials are read by the caller from
    /// the environment and passed in; this type never logs them.
    pub fn new(name: impl Into<String>, base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        LiveVenue {
            name: name.into(),
            base_url: base_url.into(),
            api_key: api_key.into(),
        }
    }

    /// Where a real implementation would sign and POST an order. Sketch of the
    /// flow, kept as a stub:
    ///
    /// 1. map [`Order`] + clip into the venue's order schema (symbol mapping,
    ///    lot/tick rounding, reduce-only flags),
    /// 2. sign the request (HMAC over body + nonce),
    /// 3. POST `{base_url}/api/v3/order`, await the ack,
    /// 4. poll the fills endpoint (or consume the user-data ws stream) until
    ///    the clip is terminal,
    /// 5. fold venue fills into a single [`Fill`] with realised fees and a
    ///    slippage figure vs `mark`.
    #[cfg(feature = "live")]
    async fn place_clip(&self, _order: &Order, _clip_qty: f64, _mark: f64) -> Result<Option<Fill>> {
        bail!("LiveVenue::place_clip is a stub; wire a real client before live trading")
    }
}

impl Venue for LiveVenue {
    fn name(&self) -> &str {
        &self.name
    }

    fn execute_clip(&mut self, _order: &Order, _clip_qty: f64, _mark: f64) -> Result<Option<Fill>> {
        // Hard stop. Routing real orders requires the `live` feature and a
        // wired client; we refuse rather than no-op so a misconfigured desk
        // fails loud instead of thinking it traded.
        bail!(
            "live venue '{}' is a stub in this build; rebuild with --features live and a real client",
            self.name
        )
    }
}
