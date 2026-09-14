"""Execution layer.

A thin :class:`Execution` protocol with two implementations:

* :class:`PaperBroker` - a deterministic simulator that fills market orders at
  the **next bar's open** plus slippage, charges fees, and tracks fills,
  positions and mark-to-market equity. This is the default and what the
  backtester and paper desk use.
* :class:`LiveBroker` - a minimal ccxt wrapper for real order placement. It is
  intentionally a thin shim: order construction and risk live upstream.

All money is in quote currency (e.g. USDT). Quantities are in base asset.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, runtime_checkable

import pandas as pd

from bibi.config import DeskConfig


@dataclass
class Fill:
    """A single execution event."""

    symbol: str
    side: int            # +1 buy, -1 sell
    price: float
    quantity: float
    fee: float
    ts: Optional[pd.Timestamp] = None

    @property
    def notional(self) -> float:
        return self.price * self.quantity


@dataclass
class Position:
    """Broker-side position accounting (average price + realised P&L)."""

    symbol: str
    side: int = 0
    quantity: float = 0.0
    avg_price: float = 0.0
    realized_pnl: float = 0.0

    @property
    def is_flat(self) -> bool:
        return self.quantity == 0.0 or self.side == 0

    def market_value(self, price: float) -> float:
        """Signed mark-to-market value of the open position at ``price``."""
        return self.side * self.quantity * price

    def unrealized_pnl(self, price: float) -> float:
        return self.side * (price - self.avg_price) * self.quantity


@runtime_checkable
class Execution(Protocol):
    """Common interface for paper and live brokers."""

    def submit(self, symbol: str, side: int, quantity: float,
               price: float, ts: Optional[pd.Timestamp] = None) -> Fill: ...

    def equity(self, marks: Dict[str, float]) -> float: ...


class PaperBroker:
    """Deterministic fill simulator with fees, slippage and P&L accounting.

    Fills are modelled at the supplied reference ``price`` (the desk passes the
    next bar's open) adjusted for slippage in the direction of the trade, which
    is the standard conservative assumption for market orders.
    """

    def __init__(self, config: DeskConfig) -> None:
        self.config = config
        self.cash: float = config.starting_equity
        self.positions: Dict[str, Position] = {}
        self.fills: List[Fill] = []

    # -------------------------------------------------------------- pricing
    def _fill_price(self, side: int, price: float) -> float:
        """Apply slippage: buyers pay up, sellers receive less."""
        slip = self.config.slippage_bps / 1e4
        return price * (1.0 + side * slip)

    def _fee(self, notional: float) -> float:
        # Single-leg fee; cost_bps is round-trip, so charge half per leg.
        return abs(notional) * (self.config.fee_bps / 1e4) / 2.0

    # --------------------------------------------------------------- submit
    def submit(self, symbol: str, side: int, quantity: float,
               price: float, ts: Optional[pd.Timestamp] = None) -> Fill:
        """Execute a market order and update cash, position and fills.

        ``side`` is the order direction (+1 buy / -1 sell); to flatten or flip a
        position the desk submits the appropriate opposite order.
        """
        if quantity <= 0:
            raise ValueError("quantity must be positive")

        fill_px = self._fill_price(side, price)
        notional = fill_px * quantity
        fee = self._fee(notional)

        # cash decreases when buying, increases when selling; fees always cost.
        self.cash -= side * notional
        self.cash -= fee

        self._apply_to_position(symbol, side, quantity, fill_px)

        fill = Fill(symbol, side, fill_px, quantity, fee, ts)
        self.fills.append(fill)
        return fill

    def _apply_to_position(self, symbol: str, side: int,
                           quantity: float, price: float) -> None:
        """Update average price / realised P&L for an incoming fill."""
        pos = self.positions.setdefault(symbol, Position(symbol))

        if pos.is_flat:
            pos.side = side
            pos.quantity = quantity
            pos.avg_price = price
            return

        if side == pos.side:
            # adding to the position: volume-weighted average price
            total = pos.quantity + quantity
            pos.avg_price = (pos.avg_price * pos.quantity + price * quantity) / total
            pos.quantity = total
            return

        # reducing / closing / flipping
        closing = min(quantity, pos.quantity)
        pos.realized_pnl += pos.side * (price - pos.avg_price) * closing
        pos.quantity -= closing
        remainder = quantity - closing
        if pos.quantity <= 1e-12:
            # fully closed; any remainder opens a new position the other way
            if remainder > 1e-12:
                pos.side = side
                pos.quantity = remainder
                pos.avg_price = price
            else:
                pos.side = 0
                pos.quantity = 0.0
                pos.avg_price = 0.0

    # --------------------------------------------------------------- equity
    def equity(self, marks: Dict[str, float]) -> float:
        """Total equity = cash + mark-to-market of all open positions."""
        mtm = 0.0
        for sym, pos in self.positions.items():
            if not pos.is_flat and sym in marks:
                mtm += pos.market_value(marks[sym])
        return self.cash + mtm

    def position(self, symbol: str) -> Position:
        return self.positions.setdefault(symbol, Position(symbol))

    def blotter(self) -> pd.DataFrame:
        """Return all fills as a DataFrame (trade log)."""
        if not self.fills:
            return pd.DataFrame(
                columns=["ts", "symbol", "side", "price", "quantity", "fee", "notional"]
            )
        return pd.DataFrame(
            [
                {
                    "ts": f.ts, "symbol": f.symbol, "side": f.side,
                    "price": f.price, "quantity": f.quantity, "fee": f.fee,
                    "notional": f.notional,
                }
                for f in self.fills
            ]
        )


class LiveBroker:
    """Thin ccxt-backed live broker. Paper is the default; this is opt-in.

    Only the minimum surface is implemented: a market order submit and an
    equity read. Anything more (limit orders, reduce-only, leverage) is left to
    the caller, deliberately, so live trading is an explicit decision.
    """

    def __init__(self, config: DeskConfig, exchange_id: str = "binance",
                 api_key: str = "", secret: str = "") -> None:
        import ccxt  # local import; live trading is optional

        self.config = config
        klass = getattr(ccxt, exchange_id)
        self._client = klass({
            "apiKey": api_key,
            "secret": secret,
            "enableRateLimit": True,
        })

    def submit(self, symbol: str, side: int, quantity: float,
               price: float, ts: Optional[pd.Timestamp] = None) -> Fill:
        """Place a market order via ccxt and wrap the response as a :class:`Fill`."""
        order_side = "buy" if side > 0 else "sell"
        order = self._client.create_order(
            symbol, type="market", side=order_side, amount=quantity
        )
        avg = float(order.get("average") or order.get("price") or price)
        fee_info = order.get("fee") or {}
        fee = float(fee_info.get("cost") or 0.0)
        return Fill(symbol, side, avg, quantity, fee, ts)

    def equity(self, marks: Dict[str, float]) -> float:
        """Read free quote balance from the exchange as a simple equity proxy."""
        bal = self._client.fetch_balance()
        return float(bal.get("total", {}).get("USDT", 0.0))
