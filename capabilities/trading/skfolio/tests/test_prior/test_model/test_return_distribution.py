"""Tests for the return-distribution value object."""

import numpy as np
import pytest

from skfolio.prior import ReturnDistribution


def _make_return_distribution(**overrides) -> ReturnDistribution:
    params = {
        "mu": np.array([0.01, 0.02]),
        "covariance": np.array([[0.04, 0.01], [0.01, 0.09]]),
        "returns": np.array([[0.01, 0.02], [-0.01, 0.03], [0.02, -0.01]]),
        "sample_weight": np.array([0.2, 0.3, 0.5]),
    }
    params.update(overrides)
    return ReturnDistribution(**params)


def test_return_distribution_reports_investable_assets():
    """Investability follows finite means and covariance diagonal entries."""
    distribution = _make_return_distribution()

    assert distribution.n_assets == 2
    assert distribution.n_investable_assets == 2
    assert distribution.investable_mask is None

    distribution = _make_return_distribution(mu=np.array([0.01, np.nan]))

    np.testing.assert_array_equal(distribution.investable_mask, [True, False])
    assert distribution.n_investable_assets == 1

    covariance = np.array([[0.04, 0.01], [0.01, np.nan]])
    distribution = _make_return_distribution(covariance=covariance)

    np.testing.assert_array_equal(distribution.investable_mask, [True, False])
    assert distribution.n_investable_assets == 1


@pytest.mark.parametrize(
    ("overrides", "match"),
    [
        ({"mu": np.ones((1, 2))}, "mu.*1D"),
        ({"covariance": np.eye(3)}, "covariance.*shape"),
        ({"returns": np.ones((3, 3))}, "returns.*shape"),
        ({"sample_weight": np.ones(2)}, "sample_weight.*shape"),
    ],
)
def test_return_distribution_rejects_incompatible_shapes(overrides, match):
    """All arrays must align with the asset and observation dimensions."""
    with pytest.raises(ValueError, match=match):
        _make_return_distribution(**overrides)


def test_return_distribution_requires_an_investable_asset():
    """A distribution with no finite expected return cannot be optimized."""
    distribution = _make_return_distribution(mu=np.full(2, np.nan))

    with pytest.raises(ValueError, match="All assets are non-investable"):
        _ = distribution.investable_mask
