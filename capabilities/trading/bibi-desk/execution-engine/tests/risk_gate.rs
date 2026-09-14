//! Integration tests for the pre-trade risk gate and the end-to-end engine.

use bibi_execution_engine::order::{Order, OrderId, OrderType, Side, TimeInForce, ExecStatus};
use bibi_execution_engine::risk::{RiskGate, RiskLimits};
use bibi_execution_engine::{Engine, EngineConfig};

fn order(id: &str, side: Side, ot: OrderType, qty: f64, price: Option<f64>) -> Order {
    Order {
        id: OrderId(id.to_string()),
        symbol: "BTC/USDT".to_string(),
        side,
        order_type: ot,
        quantity: qty,
        price,
        tif: TimeInForce::Gtc,
        slices: None,
        display_qty: None,
        venue: None,
    }
}

fn limits() -> RiskLimits {
    RiskLimits {
        max_notional: 50_000.0,
        max_position_notional: 100_000.0,
        max_price_band_bps: 200.0,
        kill_switch: false,
    }
}

#[test]
fn rejects_oversized_notional() {
    let gate = RiskGate::new(limits());
    // 1.0 BTC at 60k = 60k notional, over the 50k single-order cap.
    let o = order("o1", Side::Buy, OrderType::Market, 1.0, None);
    let d = gate.check(&o, 60_000.0);
    assert!(!d.is_pass(), "60k order should be rejected");
}

#[test]
fn passes_within_limits() {
    let gate = RiskGate::new(limits());
    let o = order("o2", Side::Buy, OrderType::Market, 0.5, None);
    assert!(gate.check(&o, 60_000.0).is_pass());
}

#[test]
fn fat_finger_limit_price_rejected() {
    let gate = RiskGate::new(limits());
    // Buy limit 10% above the mark trips the 200 bps band.
    let o = order("o3", Side::Buy, OrderType::Limit, 0.1, Some(66_000.0));
    let d = gate.check(&o, 60_000.0);
    assert!(!d.is_pass(), "limit 1000 bps off mark should be rejected");
}

#[test]
fn kill_switch_rejects_everything() {
    let mut lim = limits();
    lim.kill_switch = true;
    let gate = RiskGate::new(lim);
    let o = order("o4", Side::Buy, OrderType::Market, 0.001, None);
    assert!(!gate.check(&o, 60_000.0).is_pass());
}

#[test]
fn running_position_cap_accumulates() {
    let mut gate = RiskGate::new(limits());
    // Two 0.5 BTC buys at 60k = 30k each. After two fills the position is 60k,
    // still under the 100k cap. A third would project to 90k (ok), a fourth to
    // 120k (rejected).
    let o = order("o5", Side::Buy, OrderType::Market, 0.5, None);
    for _ in 0..3 {
        assert!(gate.check(&o, 60_000.0).is_pass());
        gate.record_fill("BTC/USDT", Side::Buy.sign(), 30_000.0);
    }
    // Running position is now 90k; the next 30k buy projects to 120k > 100k.
    assert!(!gate.check(&o, 60_000.0).is_pass());
}

#[test]
fn engine_twap_splits_and_fills() {
    let mut engine = Engine::new(EngineConfig::default());
    let mut o = order("twap-1", Side::Buy, OrderType::Twap, 0.3, None);
    o.slices = Some(3);
    let report = engine.process(&o, 60_000.0).unwrap();
    assert_eq!(report.status, ExecStatus::Filled);
    assert_eq!(report.fills.len(), 3, "TWAP of 3 should yield 3 child fills");
    assert!((report.filled_qty - 0.3).abs() < 1e-9);
    assert!(report.fees > 0.0);
}

#[test]
fn engine_rejects_are_reported_not_errored() {
    let mut engine = Engine::new(EngineConfig::default());
    // 1.0 BTC at 60k = 60k notional, over the default 50k cap.
    let o = order("big-1", Side::Buy, OrderType::Market, 1.0, None);
    let report = engine.process(&o, 60_000.0).unwrap();
    assert_eq!(report.status, ExecStatus::Rejected);
    assert!(!report.reason.is_empty());
    assert_eq!(report.filled_qty, 0.0);
}
