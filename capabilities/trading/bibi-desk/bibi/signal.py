"""Turn a :class:`~bibi.engine.Forecast` into a tradeable :class:`Signal`.

The desk is *cost-aware*: a forecast only becomes a trade if the expected move
survives frictional costs **and** clears a volatility-scaled hurdle.

Definitions (all in log-return space):

    cost   = (fee_bps + slippage_bps) / 1e4              # round-trip friction
    edge   = |E[r]| - cost                               # net expected move
    hurdle = conf_floor * sigma                          # confidence gate

A signal fires (``side != 0``) iff ``edge > hurdle``. The ``alpha`` score is
the edge normalised by sigma - a forecast information ratio net of costs -
which downstream sizing turns into a Kelly stake.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence

from bibi.config import DeskConfig
from bibi.engine import Forecast


@dataclass(frozen=True)
class Signal:
    """A directional trading decision derived from one forecast.

    Attributes
    ----------
    symbol:
        Symbol the signal applies to.
    side:
        ``+1`` long, ``-1`` short, ``0`` flat / no-trade.
    edge:
        Net expected log-return after costs (can be negative when no trade).
    sigma:
        Forecast volatility carried through from the forecast (for sizing).
    alpha:
        Cost-adjusted information ratio ``edge / sigma``; ``0`` when flat.
    reason:
        Human-readable explanation, surfaced in desk logs.
    """

    symbol: str
    side: int
    edge: float
    sigma: float
    alpha: float
    reason: str

    @property
    def is_trade(self) -> bool:
        return self.side != 0


def build_signal(forecast: Forecast, config: DeskConfig) -> Signal:
    """Convert a forecast into a cost-aware signal.

    Parameters
    ----------
    forecast:
        Output of :meth:`bibi.engine.KronosForecaster.forecast`.
    config:
        Desk config supplying ``cost_bps`` and ``conf_floor``.
    """
    cost = config.cost_bps / 1e4
    sigma = max(forecast.sigma, 1e-6)
    gross = forecast.expected_return
    # Edge is computed on the *magnitude* of the expected move: shorts profit
    # from negative E[r] symmetrically, but pay the same costs.
    edge = abs(gross) - cost
    hurdle = config.conf_floor * sigma

    if forecast.direction == 0 or edge <= hurdle:
        reason = (
            f"no-trade: edge={edge:.4f} <= hurdle={hurdle:.4f} "
            f"(E[r]={gross:.4f}, cost={cost:.4f}, sigma={sigma:.4f})"
        )
        return Signal(forecast.symbol, 0, edge, sigma, 0.0, reason)

    side = forecast.direction
    alpha = edge / sigma
    reason = (
        f"{'LONG' if side > 0 else 'SHORT'}: edge={edge:.4f} > "
        f"hurdle={hurdle:.4f}, alpha={alpha:.3f}"
    )
    return Signal(forecast.symbol, side, edge, sigma, alpha, reason)


def ensemble_vote(signals: Sequence[Signal]) -> Signal:
    """Combine several signals for the *same symbol* into one consensus signal.

    Useful when forecasting at multiple horizons or with multiple model sizes.
    The consensus side is the sign of the alpha-weighted vote; magnitude
    fields are aggregated so a unanimous, high-conviction ensemble produces a
    stronger combined alpha than a split one.

    Raises
    ------
    ValueError
        If the signals are empty or span more than one symbol.
    """
    if not signals:
        raise ValueError("ensemble_vote requires at least one signal")
    symbols = {s.symbol for s in signals}
    if len(symbols) != 1:
        raise ValueError(f"ensemble_vote mixes symbols: {sorted(symbols)}")
    symbol = symbols.pop()

    # Signed alpha vote: longs contribute +alpha, shorts -alpha.
    vote = sum(s.side * s.alpha for s in signals)
    side = 1 if vote > 0 else (-1 if vote < 0 else 0)

    if side == 0:
        return Signal(symbol, 0, 0.0, _avg_sigma(signals), 0.0,
                      "ensemble: split vote, standing aside")

    # Aggregate only the members that agree with the consensus side.
    agree = [s for s in signals if s.side == side]
    edge = sum(s.edge for s in agree) / len(agree)
    sigma = _avg_sigma(agree)
    # Normalise conviction by the members that actually voted, not the whole
    # set: an abstaining (flat) member shouldn't water down the alpha of an
    # otherwise unanimous, high-conviction ensemble.
    voters = sum(1 for s in signals if s.side != 0) or 1
    alpha = abs(vote) / voters
    reason = (
        f"ensemble {'LONG' if side > 0 else 'SHORT'}: "
        f"{len(agree)}/{len(signals)} agree, alpha={alpha:.3f}"
    )
    return Signal(symbol, side, edge, sigma, alpha, reason)


def _avg_sigma(signals: Sequence[Signal]) -> float:
    return sum(s.sigma for s in signals) / max(len(signals), 1)
