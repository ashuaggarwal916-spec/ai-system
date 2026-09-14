"""Fractional-Kelly position sizing.

For a continuous bet whose per-trade return has expectation ``edge`` and
variance ``sigma^2`` (both in log-return space), the growth-optimal Kelly
fraction of capital to deploy is::

    f* = edge / sigma^2

This is the continuous/Gaussian analogue of the classic discrete Kelly
``f* = p - q/b``. Full Kelly maximises long-run log-wealth but is brutally
volatile and acutely sensitive to estimation error, so practitioners deploy a
*fraction* of it (quarter-Kelly is common). We therefore size at::

    f = clip(kelly_fraction * f*, 0, f_max)

and then cap the resulting notional two more ways:

  * **risk_per_trade_R** - the stop distance implies a loss per unit notional;
    we never let a single stop-out cost more than ``risk_per_trade_R`` of
    equity (one "R").
  * **max_positions** - equity is shared across at most this many slots, so a
    single position cannot consume more than ``equity / max_positions``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from bibi.config import DeskConfig
from bibi.signal import Signal

# Hard ceiling on the raw Kelly fraction before the user's kelly_fraction is
# applied. Guards against pathological tiny-sigma forecasts demanding >100%.
_MAX_RAW_KELLY = 1.0


@dataclass(frozen=True)
class SizingResult:
    """Outcome of a sizing decision.

    Attributes
    ----------
    notional:
        Quote-currency notional to deploy (always >= 0; direction lives on the
        signal/position).
    quantity:
        Base-asset quantity = ``notional / price``.
    kelly_fraction:
        The post-clamp fraction of equity allocated.
    raw_kelly:
        The uncapped ``edge / sigma^2`` for transparency/logging.
    binding_cap:
        Which cap was binding: ``"kelly"``, ``"risk_R"``, ``"slots"`` or
        ``"none"``.
    """

    notional: float
    quantity: float
    kelly_fraction: float
    raw_kelly: float
    binding_cap: str

    @property
    def is_zero(self) -> bool:
        return self.notional <= 0.0


def kelly_size(
    signal: Signal,
    equity: float,
    price: float,
    config: DeskConfig,
    *,
    stop_distance_frac: Optional[float] = None,
    open_positions: int = 0,
) -> SizingResult:
    """Compute a fractional-Kelly stake for ``signal``.

    Parameters
    ----------
    signal:
        The (non-flat) signal to size. A flat signal returns a zero result.
    equity:
        Current account equity in quote currency.
    price:
        Reference price used to convert notional to base quantity.
    config:
        Supplies ``kelly_fraction``, ``risk_per_trade_R`` and ``max_positions``.
    stop_distance_frac:
        Fractional distance to the protective stop (e.g. ``0.02`` = 2%). Used
        for the per-trade R cap. If ``None``, the R cap is skipped.
    open_positions:
        Number of positions already open, for the slot cap.

    Returns
    -------
    SizingResult
    """
    if not signal.is_trade or equity <= 0 or price <= 0:
        return SizingResult(0.0, 0.0, 0.0, 0.0, "none")

    # --- raw Kelly: edge / sigma^2 ----------------------------------------
    sigma2 = max(signal.sigma ** 2, 1e-12)
    raw_kelly = signal.edge / sigma2
    raw_kelly = max(0.0, min(raw_kelly, _MAX_RAW_KELLY))

    # --- apply the user's fractional-Kelly multiplier ---------------------
    kelly_frac = config.kelly_fraction * raw_kelly
    binding = "kelly"

    # --- cap 1: per-trade R -----------------------------------------------
    # A position of fraction f, stopped out at stop_distance_frac, loses
    # f * stop_distance_frac of equity. Bound that by risk_per_trade_R.
    if stop_distance_frac and stop_distance_frac > 0:
        r_cap_frac = config.risk_per_trade_R / stop_distance_frac
        if r_cap_frac < kelly_frac:
            kelly_frac, binding = r_cap_frac, "risk_R"

    # --- cap 2: concurrent slots ------------------------------------------
    remaining_slots = max(config.max_positions - open_positions, 0)
    if remaining_slots == 0:
        return SizingResult(0.0, 0.0, 0.0, raw_kelly, "slots")
    slot_cap_frac = 1.0 / config.max_positions
    if slot_cap_frac < kelly_frac:
        kelly_frac, binding = slot_cap_frac, "slots"

    kelly_frac = max(0.0, min(kelly_frac, 1.0))
    notional = kelly_frac * equity
    quantity = notional / price
    return SizingResult(notional, quantity, kelly_frac, raw_kelly, binding)
