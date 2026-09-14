"""Desk configuration.

A single :class:`DeskConfig` dataclass carries every knob the pipeline needs,
from the Kronos model selection down to the fractional-Kelly cap. Keeping the
configuration in one immutable object makes runs reproducible and trivially
serialisable (a run is fully described by its config plus the input candles).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List

# Hugging Face repos for the public Kronos checkpoints. The tokenizer is shared
# across model sizes; only the backbone changes. Context windows differ:
#   Kronos-mini  -> 2048    Kronos-small -> 512    Kronos-base -> 512
KRONOS_MODELS: Dict[str, Dict[str, Any]] = {
    "Kronos-mini": {"repo": "NeoQuasar/Kronos-mini", "max_context": 2048,
                    "tokenizer": "NeoQuasar/Kronos-Tokenizer-2k"},
    "Kronos-small": {"repo": "NeoQuasar/Kronos-small", "max_context": 512,
                     "tokenizer": "NeoQuasar/Kronos-Tokenizer-base"},
    "Kronos-base": {"repo": "NeoQuasar/Kronos-base", "max_context": 512,
                    "tokenizer": "NeoQuasar/Kronos-Tokenizer-base"},
}


@dataclass(frozen=True)
class DeskConfig:
    """Immutable configuration for a Bibi trading desk.

    Attributes
    ----------
    symbols:
        Exchange symbols to trade, in ccxt unified notation (``"BTC/USDT"``).
    timeframe:
        Candle period understood by the exchange (``"1h"``, ``"15m"`` ...).
    model_name:
        One of :data:`KRONOS_MODELS`.
    max_context:
        Number of trailing bars fed to Kronos. Capped to the model's window.
    pred_len:
        Forecast horizon in bars.
    sample_count:
        Number of Monte-Carlo sample paths drawn per forecast. Dispersion of
        the paths is used as the forecast's confidence (sigma).
    kelly_fraction:
        Fraction of the full Kelly stake actually deployed (``0.25`` = quarter
        Kelly). Full Kelly is famously over-aggressive; we always size down.
    fee_bps, slippage_bps:
        Round-trip taker fee and assumed slippage, each in basis points. These
        feed directly into the cost-aware edge in :mod:`bibi.signal`.
    conf_floor:
        Confidence floor as a multiple of forecast sigma. A trade only fires if
        ``edge > conf_floor * sigma`` - i.e. the expected move must clear a
        volatility-scaled hurdle.
    max_positions:
        Maximum number of concurrent open positions across all symbols.
    risk_per_trade_R:
        Capital risked per trade expressed as a fraction of equity (one "R").
        Caps the Kelly stake so a single stop-out costs at most this much.
    atr_period, atr_stop_mult, take_profit_R:
        Risk-manager parameters (see :mod:`bibi.risk`).
    max_daily_drawdown:
        Equity drawdown over a UTC day that trips the kill-switch.
    temperature, top_p:
        Kronos sampling temperature (``T``) and nucleus ``top_p``.
    device:
        Torch device string for inference.
    """

    symbols: List[str] = field(default_factory=lambda: ["BTC/USDT", "ETH/USDT"])
    timeframe: str = "1h"

    # --- model / inference -------------------------------------------------
    model_name: str = "Kronos-small"
    max_context: int = 512
    pred_len: int = 24
    sample_count: int = 30
    temperature: float = 1.0
    top_p: float = 0.9
    device: str = "cpu"

    # --- signal / cost -----------------------------------------------------
    fee_bps: float = 6.0
    slippage_bps: float = 4.0
    conf_floor: float = 0.5

    # --- sizing / risk -----------------------------------------------------
    kelly_fraction: float = 0.25
    max_positions: int = 4
    risk_per_trade_R: float = 0.01
    atr_period: int = 14
    atr_stop_mult: float = 2.0
    take_profit_R: float = 2.0
    max_daily_drawdown: float = 0.08

    # --- accounting --------------------------------------------------------
    starting_equity: float = 100_000.0

    def __post_init__(self) -> None:
        if self.model_name not in KRONOS_MODELS:
            raise ValueError(
                f"unknown model {self.model_name!r}; "
                f"choose from {sorted(KRONOS_MODELS)}"
            )
        window = KRONOS_MODELS[self.model_name]["max_context"]
        if self.max_context > window:
            # frozen dataclass: bypass the lock to clamp to the model window.
            object.__setattr__(self, "max_context", window)
        if not 0.0 < self.kelly_fraction <= 1.0:
            raise ValueError("kelly_fraction must lie in (0, 1]")
        if self.pred_len < 1:
            raise ValueError("pred_len must be >= 1")
        if self.sample_count < 1:
            raise ValueError("sample_count must be >= 1")

    # ------------------------------------------------------------------ repos
    @property
    def model_repo(self) -> str:
        """Hugging Face repo id for the selected backbone."""
        return KRONOS_MODELS[self.model_name]["repo"]

    @property
    def tokenizer_repo(self) -> str:
        """Hugging Face repo id for the matching tokenizer."""
        return KRONOS_MODELS[self.model_name]["tokenizer"]

    @property
    def cost_bps(self) -> float:
        """Total round-trip frictional cost in basis points."""
        return self.fee_bps + self.slippage_bps

    # ----------------------------------------------------------------- (de)ser
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "DeskConfig":
        """Load a config from a YAML file, ignoring unknown keys gracefully.

        Only keys matching dataclass fields are forwarded, so a YAML file may
        carry extra documentation/annotation keys without breaking the loader.
        """
        import yaml  # local import keeps PyYAML optional for pure-API users

        raw = yaml.safe_load(Path(path).read_text()) or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{path}: expected a mapping at the top level")
        valid = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        kwargs = {k: v for k, v in raw.items() if k in valid}
        return cls(**kwargs)
