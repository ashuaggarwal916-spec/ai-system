//! Integration tests for the paper book matcher and the fill simulator.

use bibi_execution_engine::book::{BookConfig, OrderBook};
use bibi_execution_engine::order::Side;

fn cfg() -> BookConfig {
    BookConfig {
        half_spread_bps: 1.0,
        tick_bps: 0.5,
        level_depth: 1.0,
        levels: 10,
        fee_bps: 10.0,
    }
}

#[test]
fn market_buy_fills_at_or_above_mark() {
    let mark = 100.0;
    let mut book = OrderBook::synthetic(mark, cfg());
    // Clip of 1.0 fits in the first ask level (depth 1.0).
    let fill = book
        .take("BTC/USDT", Side::Buy, 1.0, None, mark, "paper")
        .expect("should fill");
    assert!((fill.quantity - 1.0).abs() < 1e-9);
    // Buyer lifts the ask, which sits above the mark, so slippage is positive.
    assert!(fill.price >= mark);
    assert!(fill.slippage_bps > 0.0);
    assert!(fill.fee > 0.0);
}

#[test]
fn large_market_order_walks_multiple_levels_partial() {
    let mark = 100.0;
    let mut book = OrderBook::synthetic(mark, cfg());
    // 10 levels * depth 1.0 = 10.0 total available. Ask for 25, expect a
    // partial fill capped at available liquidity.
    let fill = book
        .take("BTC/USDT", Side::Buy, 25.0, None, mark, "paper")
        .expect("should fill what it can");
    assert!((fill.quantity - 10.0).abs() < 1e-9, "got {}", fill.quantity);
    // Average price strictly worse than the touch because it walked the book.
    assert!(fill.price > mark);
}

#[test]
fn limit_buy_below_market_does_not_fill() {
    let mark = 100.0;
    let mut book = OrderBook::synthetic(mark, cfg());
    // A buy limit one tick below the best ask never crosses.
    let limit = mark - 1.0;
    let res = book.take("BTC/USDT", Side::Buy, 1.0, Some(limit), mark, "paper");
    assert!(res.is_none(), "non-crossing limit should not fill");
}

#[test]
fn limit_buy_above_market_crosses_and_fills() {
    let mark = 100.0;
    let mut book = OrderBook::synthetic(mark, cfg());
    let limit = mark + 5.0; // generous, crosses several levels
    let fill = book
        .take("BTC/USDT", Side::Buy, 3.0, Some(limit), mark, "paper")
        .expect("crossing limit fills");
    assert!((fill.quantity - 3.0).abs() < 1e-9);
    assert!(fill.price <= limit + 1e-9);
}

#[test]
fn sell_slippage_is_positive_when_worse_than_mark() {
    let mark = 100.0;
    let mut book = OrderBook::synthetic(mark, cfg());
    let fill = book
        .take("BTC/USDT", Side::Sell, 1.0, None, mark, "paper")
        .expect("should fill");
    // Seller hits the bid below the mark; slippage convention makes this > 0.
    assert!(fill.price <= mark);
    assert!(fill.slippage_bps > 0.0);
}
