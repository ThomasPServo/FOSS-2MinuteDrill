"""Model fitting: the numpy solvers recover known coefficients, and the built models are sane."""

import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import models

DATA = Path(__file__).resolve().parents[2] / "web" / "data"


def test_logistic_recovers_coefficients():
    rng = np.random.default_rng(1)
    X = np.c_[np.ones(20000), rng.normal(size=(20000, 2))]
    beta = np.array([-0.5, 1.2, -0.8])
    y = rng.random(20000) < 1 / (1 + np.exp(-(X @ beta)))
    fit = models.fit_logistic(X, y, l2=0.0)
    assert np.allclose(fit, beta, atol=0.08)


def test_multinomial_recovers_coefficients():
    rng = np.random.default_rng(2)
    X = np.c_[np.ones(30000), rng.normal(size=(30000, 2))]
    coef = np.array([[0, 0, 0], [0.3, 1.0, -0.5], [-0.4, -0.7, 0.9]])
    probs = models.fourth_probs(coef, X)
    y = np.array([rng.choice(3, p=p) for p in probs])
    fit = models.fit_multinomial(X, y, 3, l2=0.0)
    assert np.allclose(fit[0], 0)
    assert np.allclose(fit, coef, atol=0.1)


def test_fg_probability_decreases_with_distance_synthetic():
    rng = np.random.default_rng(3)
    yl = rng.integers(1, 45, 5000)
    p_true = 1 / (1 + np.exp(-(6.0 - 0.11 * (yl + 18))))
    made = rng.random(5000) < p_true
    coef = models.fit_logistic(models.fg_features(yl, np.zeros(5000), np.zeros(5000)), made)
    probs = models.fg_make_prob(coef, np.arange(1, 45))
    assert np.all(np.diff(probs) < 0)


def _special():
    path = DATA / "special.json"
    if not path.exists():
        pytest.skip("web/data not built")
    return json.loads(path.read_text())


def test_built_fg_model_is_monotone():
    fg = _special()["fg"]
    probs = models.fg_make_prob(fg["coef"], np.arange(1, 50))   # 19- to 67-yard kicks
    assert np.all(np.diff(probs) < 0)
    assert probs[0] > 0.97 and probs[-1] < 0.6


def test_built_fourth_down_model_goes_more_on_short_yardage():
    fourth = _special()["fourth"]
    assert fourth["classes"] == ["go", "fg", "punt"]
    assert fourth["features"] == models.FOURTH_FEATURES
    for yl in (30, 45, 60):
        for margin, gsl, qtr in ((0, 1800, 3), (-4, 400, 4), (7, 2400, 2)):
            X = models.fourth_features([yl, yl], [1, 10], [margin] * 2, [gsl] * 2, [qtr] * 2,
                                       [gsl % 1800 or 1800] * 2)
            go = models.fourth_probs(fourth["coef"], X)[:, 0]
            assert go[0] > go[1], (yl, margin)


def test_built_halftime_wp_increases_with_margin_and_spread():
    coef = np.array(_special()["halftime_wp"]["coef"])
    assert coef[1] > 0 and coef[3] > 0
