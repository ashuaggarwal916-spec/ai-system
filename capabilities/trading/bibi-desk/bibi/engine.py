"""Kronos forecasting engine.

:class:`KronosForecaster` wraps the upstream ``KronosPredictor`` and turns a
window of candles into a :class:`Forecast`: an expected log-return over the
horizon, a forecast volatility estimated from the dispersion of Monte-Carlo
sample paths, a discrete direction, and the raw predicted bars.

The dispersion-as-confidence idea is the crux of the desk. Kronos is a
generative model: each ``predict`` call with ``sample_count > 1`` draws several
plausible future paths. The *mean* terminal return is our point estimate
``E[r]``; the *standard deviation* of terminal returns across paths is our
``sigma``. A tight bundle of paths -> high confidence -> larger Kelly stake; a
fan of disagreeing paths -> low confidence -> we stand aside.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
import pandas as pd

from bibi.config import DeskConfig

logger = logging.getLogger(__name__)


@dataclass
class Forecast:
    """Aggregated output of a Kronos forecast over ``pred_len`` bars.

    Attributes
    ----------
    symbol:
        Symbol this forecast is for.
    expected_return:
        ``E[r]`` - mean horizon log-return across sample paths.
    sigma:
        Standard deviation of horizon log-returns across sample paths. Used as
        the forecast confidence (smaller => more confident).
    direction:
        ``sign(E[r])`` as ``+1`` / ``-1`` / ``0``.
    last_close:
        Most recent observed close (entry reference price).
    mean_path:
        Element-wise mean predicted close path (length ``pred_len``).
    pred_bars:
        Mean predicted OHLCV bars (a DataFrame). Convenient for plotting.
    n_paths:
        Number of Monte-Carlo paths aggregated.
    """

    symbol: str
    expected_return: float
    sigma: float
    direction: int
    last_close: float
    mean_path: np.ndarray
    pred_bars: pd.DataFrame
    n_paths: int = 1

    @property
    def expected_price(self) -> float:
        """Forecast terminal close implied by ``E[r]``."""
        return float(self.last_close * np.exp(self.expected_return))

    @property
    def sharpe_like(self) -> float:
        """Forecast information ratio ``E[r] / sigma`` (guards sigma ~ 0)."""
        return float(self.expected_return / self.sigma) if self.sigma > 1e-12 else 0.0


class KronosForecaster:
    """Loads a Kronos checkpoint and produces :class:`Forecast` objects.

    The heavy model dependencies (``torch``, the Kronos ``model`` package, and
    ``huggingface_hub``) are imported lazily inside :meth:`load`, so importing
    this module never pulls in multi-hundred-MB libraries. Until :meth:`load`
    is called the forecaster is inert.
    """

    def __init__(self, config: DeskConfig) -> None:
        self.config = config
        self._predictor = None  # type: Optional[object]

    # --------------------------------------------------------------- loading
    @property
    def is_loaded(self) -> bool:
        return self._predictor is not None

    def load(self) -> "KronosForecaster":
        """Load tokenizer + backbone from Hugging Face and build the predictor.

        Mirrors the upstream Kronos quick-start exactly::

            tokenizer = KronosTokenizer.from_pretrained(...)
            model     = Kronos.from_pretrained(...)
            predictor = KronosPredictor(model, tokenizer, max_context=...)
        """
        from model import Kronos, KronosTokenizer, KronosPredictor  # type: ignore

        cfg = self.config
        logger.info("loading Kronos tokenizer %s", cfg.tokenizer_repo)
        tokenizer = KronosTokenizer.from_pretrained(cfg.tokenizer_repo)
        logger.info("loading Kronos backbone %s", cfg.model_repo)
        model = Kronos.from_pretrained(cfg.model_repo)

        self._predictor = KronosPredictor(
            model, tokenizer, device=cfg.device, max_context=cfg.max_context
        )
        return self

    def attach_predictor(self, predictor: object) -> "KronosForecaster":
        """Inject a pre-built predictor (or a stub) - handy for tests/backtests."""
        self._predictor = predictor
        return self

    # -------------------------------------------------------------- forecast
    def _context_window(self, candles: pd.DataFrame) -> pd.DataFrame:
        """Truncate ``candles`` to the model context window (last N bars)."""
        n = self.config.max_context
        return candles.iloc[-n:] if len(candles) > n else candles

    def _future_timestamps(self, last_ts: pd.Timestamp, pred_len: int) -> pd.Series:
        """Build the forward timestamp index Kronos requires for the horizon."""
        freq = pd.infer_freq(self._last_index) if self._last_index is not None else None
        # fall back to the spacing between the final two observed bars
        if freq is None and self._last_index is not None and len(self._last_index) >= 2:
            step = self._last_index[-1] - self._last_index[-2]
        else:
            step = pd.tseries.frequencies.to_offset(freq) if freq else pd.Timedelta("1h")
        start = last_ts + step
        return pd.Series(pd.date_range(start=start, periods=pred_len, freq=step))

    _last_index: Optional[pd.DatetimeIndex] = None

    def forecast(self, symbol: str, candles: pd.DataFrame,
                 pred_len: Optional[int] = None) -> Forecast:
        """Forecast ``pred_len`` bars ahead and aggregate the sample paths.

        Parameters
        ----------
        symbol:
            Symbol label carried into the returned :class:`Forecast`.
        candles:
            Normalised OHLCV frame (see :mod:`bibi.data`) with a DatetimeIndex.
        pred_len:
            Horizon override; defaults to ``config.pred_len``.

        Returns
        -------
        Forecast
        """
        if not self.is_loaded:
            raise RuntimeError("forecaster not loaded; call .load() first")

        cfg = self.config
        horizon = int(pred_len or cfg.pred_len)
        ctx = self._context_window(candles)
        self._last_index = ctx.index  # used by _future_timestamps

        x_df = ctx.loc[:, ["open", "high", "low", "close", "volume", "amount"]]
        x_ts = ctx.index.to_series().reset_index(drop=True)
        y_ts = self._future_timestamps(ctx.index[-1], horizon)
        last_close = float(ctx["close"].iloc[-1])

        # Draw the Monte-Carlo paths. The upstream predictor exposes
        # ``sample_count``; some builds return a single averaged frame, so we
        # also support manual repetition as a fallback.
        paths = self._draw_paths(x_df, x_ts, y_ts, horizon, cfg)

        # Each path is a (horizon,) close array. Stack -> (n_paths, horizon).
        closes = np.vstack([p["close"].to_numpy(dtype=float) for p in paths])
        terminal_returns = np.log(closes[:, -1] / last_close)

        e_r = float(np.mean(terminal_returns))
        sigma = float(np.std(terminal_returns, ddof=1)) if len(paths) > 1 else \
            self._intrinsic_sigma(closes[0], last_close)
        direction = int(np.sign(e_r)) if abs(e_r) > 1e-9 else 0

        mean_path = closes.mean(axis=0)
        mean_bars = self._mean_bars(paths)

        logger.debug(
            "forecast %s: E[r]=%.4f sigma=%.4f dir=%+d paths=%d",
            symbol, e_r, sigma, direction, len(paths),
        )
        return Forecast(
            symbol=symbol,
            expected_return=e_r,
            sigma=max(sigma, 1e-6),
            direction=direction,
            last_close=last_close,
            mean_path=mean_path,
            pred_bars=mean_bars,
            n_paths=len(paths),
        )

    # ----------------------------------------------------------- internals
    def _draw_paths(self, x_df, x_ts, y_ts, horizon, cfg) -> List[pd.DataFrame]:
        """Return a list of per-path predicted OHLCV frames."""
        # Preferred: ask the predictor for all paths in one shot.
        out = self._predictor.predict(  # type: ignore[union-attr]
            df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
            pred_len=horizon, T=cfg.temperature, top_p=cfg.top_p,
            sample_count=cfg.sample_count,
        )
        if isinstance(out, list):
            return out
        # Single frame returned: re-sample to recover dispersion when asked for
        # more than one path. (Stochastic sampling => distinct draws.)
        if cfg.sample_count <= 1:
            return [out]
        paths = [out]
        for _ in range(cfg.sample_count - 1):
            paths.append(
                self._predictor.predict(  # type: ignore[union-attr]
                    df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
                    pred_len=horizon, T=cfg.temperature, top_p=cfg.top_p,
                    sample_count=1,
                )
            )
        return paths

    @staticmethod
    def _mean_bars(paths: List[pd.DataFrame]) -> pd.DataFrame:
        """Element-wise mean of the predicted OHLCV frames across paths."""
        if len(paths) == 1:
            return paths[0].copy()
        stack = np.stack([p.to_numpy(dtype=float) for p in paths], axis=0)
        return pd.DataFrame(stack.mean(axis=0), columns=paths[0].columns,
                            index=paths[0].index)

    @staticmethod
    def _intrinsic_sigma(path: np.ndarray, last_close: float) -> float:
        """Fallback sigma from a single path: std of its per-bar log-returns.

        When only one sample path is available we cannot measure cross-path
        dispersion, so we fall back to the path's own realised volatility as a
        conservative confidence proxy.
        """
        series = np.concatenate([[last_close], path])
        rets = np.diff(np.log(series))
        return float(np.std(rets, ddof=1)) if len(rets) > 1 else 0.01
