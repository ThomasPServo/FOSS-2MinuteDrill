"""Small statistical models for ``special.json``, fitted with numpy only.

Fitting
-------
``fit_logistic`` and ``fit_multinomial`` maximise a (lightly L2-penalised) likelihood by
Newton's method with step halving. The intercept (feature ``const``) is not penalised.

Models and exact feature definitions (the engine must compute features identically)
-----------------------------------------------------------------------------------
``fg`` - P(field goal is good) over all attempts (blocked kicks count as misses)::

    const = 1
    dist  = yl + 18                (kick distance in yards)
    dist2 = dist * dist / 100
    indoor = 1 for roof dome/closed, else 0
    wind  = wind speed in mph (0 indoors)

``fourth`` - NFL fourth-down decision, classes go / fg / punt (go is the reference)::

    const       = 1
    yl          = yl / 10                       (yards to the opponent's goal / 10)
    yl_sq       = (yl / 10) ** 2
    log_ytg     = ln(ytg)
    fg_long     = max(0, yl + 18 - 45) / 10     (kick distance beyond 45 yards / 10)
    margin      = clip(margin, -21, 21) / 7     (offense minus defense)
    time_left   = game_seconds_left / 3600      (0 in overtime)
    margin_late = margin * (1 - time_left)
    trail_late  = 1 if margin < 0 and the 4th quarter/OT has <= 10:00 left
    need_td     = 1 if margin <= -4 and the 4th quarter/OT has <= 10:00 left
    lead_late   = 1 if margin > 0 and the 4th quarter/OT has <= 10:00 left
    half_end    = 1 if 2nd quarter with <= 2:00 left

    score_k = coef[k] . x ;  P(k) = exp(score_k) / sum_j exp(score_j)

``go2`` - smoothed share of touchdowns followed by a two-point try, by the scoring
team's margin after the touchdown and before the try (``early``: more than 5:00 left in
the game, ``late``: 5:00 or less in the second half). Overtime is excluded. Each margin
is a kernel-weighted average of its neighbours (weights 1, 2, 4, 2, 1 for offsets
-2..2) shrunk toward the overall rate with a prior of 3 tries.

``halftime_wp`` - P(win) for a team at halftime (ties excluded)::

    const = 1, margin = team score - opponent score at halftime,
    receive2h = 1 if the team receives the second-half kickoff, spread = points the team
    is favoured by (nflverse spread_line from the home side; negated for the away team)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

FG_FEATURES = ["const", "dist", "dist2", "indoor", "wind"]
FOURTH_CLASSES = ["go", "fg", "punt"]
FOURTH_FEATURES = ["const", "yl", "yl_sq", "log_ytg", "fg_long", "margin", "time_left",
                   "margin_late", "trail_late", "need_td", "lead_late", "half_end"]
HALFTIME_FEATURES = ["const", "margin", "receive2h", "spread"]
GO2_MARGINS = (-20, 20)
GO2_KERNEL = np.array([1, 2, 4, 2, 1], dtype=float)
GO2_PRIOR = 3.0


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1e-3, iters: int = 100) -> np.ndarray:
    """Binary logistic regression by Newton's method. Column 0 must be the intercept."""
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    n, p = X.shape
    penalty = np.full(p, l2 * n)
    penalty[0] = 0.0
    beta = np.zeros(p)

    def loss(b):
        z = X @ b
        return -(y * z - np.logaddexp(0, z)).sum() + 0.5 * (penalty * b * b).sum()

    current = loss(beta)
    for _ in range(iters):
        prob = _sigmoid(X @ beta)
        grad = X.T @ (prob - y) + penalty * beta
        hess = (X * (prob * (1 - prob))[:, None]).T @ X + np.diag(penalty)
        step = np.linalg.solve(hess, grad)
        t = 1.0
        while t > 1e-6 and loss(beta - t * step) > current:
            t /= 2
        beta = beta - t * step
        new = loss(beta)
        if abs(current - new) < 1e-9 * max(1.0, abs(current)):
            break
        current = new
    return beta


def fit_multinomial(X: np.ndarray, y: np.ndarray, n_classes: int, l2: float = 1e-3,
                    iters: int = 100) -> np.ndarray:
    """Multinomial logistic regression with class 0 as the all-zero reference.

    Returns a (n_classes, p) array. Newton's method on the stacked (K-1)*p parameters.
    """
    X = np.asarray(X, float)
    y = np.asarray(y, int)
    n, p = X.shape
    k = n_classes - 1
    Y = np.eye(n_classes)[y][:, 1:]
    penalty = np.tile(np.r_[0.0, np.full(p - 1, l2 * n)], k)
    beta = np.zeros(k * p)

    def probs(b):
        scores = np.c_[np.zeros(n), X @ b.reshape(k, p).T]
        scores -= scores.max(axis=1, keepdims=True)
        e = np.exp(scores)
        return e / e.sum(axis=1, keepdims=True)

    def loss(b):
        P = probs(b)
        return -np.log(P[np.arange(n), y] + 1e-300).sum() + 0.5 * (penalty * b * b).sum()

    current = loss(beta)
    for _ in range(iters):
        P = probs(beta)[:, 1:]
        grad = ((P - Y).T @ X).ravel() + penalty * beta
        hess = np.zeros((k * p, k * p))
        for a in range(k):
            for b in range(k):
                w = P[:, a] * ((a == b) - P[:, b])
                hess[a * p:(a + 1) * p, b * p:(b + 1) * p] = (X * w[:, None]).T @ X
        hess += np.diag(penalty)
        step = np.linalg.solve(hess, grad)
        t = 1.0
        while t > 1e-6 and loss(beta - t * step) > current:
            t /= 2
        beta = beta - t * step
        new = loss(beta)
        if abs(current - new) < 1e-9 * max(1.0, abs(current)):
            break
        current = new
    return np.vstack([np.zeros(p), beta.reshape(k, p)])


def _rounded(values, digits=5) -> list:
    return [round(float(v), digits) for v in np.ravel(values)]


# --- field goals ------------------------------------------------------------------------

def fg_features(yl, indoor, wind) -> np.ndarray:
    dist = np.asarray(yl, float) + 18
    return np.c_[np.ones_like(dist), dist, dist * dist / 100,
                 np.asarray(indoor, float), np.asarray(wind, float)]


def game_wind(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(indoor 0/1, wind mph) per row; missing outdoor wind gets the outdoor median."""
    indoor = df["roof"].isin(["dome", "closed"]).to_numpy()
    wind = pd.to_numeric(df["wind"], errors="coerce").to_numpy(float)
    outdoor_median = np.nanmedian(wind[~indoor]) if (~indoor).any() else 0.0
    wind = np.where(indoor, 0.0, np.where(np.isfinite(wind), wind, outdoor_median))
    return indoor.astype(float), wind


def fit_fg(seq: pd.DataFrame) -> dict:
    kicks = seq[seq["play_type"].eq("field_goal") & seq["field_goal_result"].notna()]
    indoor, wind = game_wind(kicks)
    X = fg_features(kicks["yardline_100"], indoor, wind)
    y = kicks["field_goal_result"].eq("made").to_numpy()
    coef = fit_logistic(X, y, l2=1e-5)
    return {"features": FG_FEATURES, "coef": _rounded(coef, 6),
            "blocked": round(float(kicks["field_goal_result"].eq("blocked").mean()), 4),
            "n": int(len(kicks))}


def fg_make_prob(coef, yl, indoor: float = 0.0, wind: float = 0.0) -> np.ndarray:
    yl = np.atleast_1d(np.asarray(yl, float))
    X = fg_features(yl, np.full_like(yl, indoor), np.full_like(yl, wind))
    return _sigmoid(X @ np.asarray(coef, float))


# --- fourth downs -----------------------------------------------------------------------

def fourth_features(yl, ytg, margin, game_seconds_left, qtr, half_seconds_left) -> np.ndarray:
    yl = np.asarray(yl, float)
    ytg = np.maximum(np.asarray(ytg, float), 1)
    margin_raw = np.asarray(margin, float)
    qtr = np.asarray(qtr, float)
    gsl = np.where(qtr >= 5, 0.0, np.asarray(game_seconds_left, float))
    hs = np.asarray(half_seconds_left, float)
    margin7 = np.clip(margin_raw, -21, 21) / 7
    time_left = gsl / 3600
    late = ((qtr == 4) & (gsl <= 600)) | ((qtr >= 5) & (hs <= 600))
    return np.c_[
        np.ones_like(yl), yl / 10, (yl / 10) ** 2, np.log(ytg),
        np.maximum(0, yl + 18 - 45) / 10, margin7, time_left, margin7 * (1 - time_left),
        (late & (margin_raw < 0)).astype(float), (late & (margin_raw <= -4)).astype(float),
        (late & (margin_raw > 0)).astype(float), ((qtr == 2) & (hs <= 120)).astype(float),
    ]


def fourth_decisions(seq: pd.DataFrame) -> pd.DataFrame:
    """Fourth-down snaps with the decision class (0 go, 1 fg, 2 punt)."""
    plays = seq[seq["down"].eq(4) & seq["play_type"].isin(["run", "pass", "field_goal", "punt"])
                & seq["posteam"].notna()].copy()
    plays = plays[pd.to_numeric(plays["qb_kneel"], errors="coerce").fillna(0).eq(0)]
    plays["decision"] = plays["play_type"].map({"run": 0, "pass": 0, "field_goal": 1, "punt": 2})
    return plays


def fit_fourth(seq: pd.DataFrame) -> dict:
    plays = fourth_decisions(seq)
    X = fourth_features(plays["yardline_100"], plays["ydstogo"], plays["score_differential"],
                        plays["game_seconds_remaining"], plays["qtr"],
                        plays["half_seconds_remaining"])
    coef = fit_multinomial(X, plays["decision"].to_numpy(), len(FOURTH_CLASSES), l2=1e-4)
    return {"classes": FOURTH_CLASSES, "features": FOURTH_FEATURES,
            "coef": [_rounded(row) for row in coef]}


def fourth_probs(coef, X) -> np.ndarray:
    scores = np.asarray(X, float) @ np.asarray(coef, float).T
    scores -= scores.max(axis=1, keepdims=True)
    e = np.exp(scores)
    return e / e.sum(axis=1, keepdims=True)


# --- going for two ----------------------------------------------------------------------

def pat_decisions(seq: pd.DataFrame) -> pd.DataFrame:
    """One row per touchdown: the final PAT choice (two=1) and the scoring team's margin."""
    two = pd.to_numeric(seq["two_point_attempt"], errors="coerce").fillna(0).eq(1)
    pats = seq[(seq["play_type"].eq("extra_point") | (two & seq["play_type"].isin(["run", "pass"])))
               & seq["posteam"].notna() & seq["qtr"].le(4)].copy()
    pats["two"] = two.loc[pats.index].astype(int)
    pats = pats.drop_duplicates(["game_id", "total_home_score", "total_away_score"], keep="last")
    pats["margin"] = pats["posteam_score"] - pats["defteam_score"]
    pats["late"] = pats["second_half"] & (pats["game_seconds_remaining"] <= 300)
    return pats


def fit_go2(seq: pd.DataFrame) -> dict:
    pats = pat_decisions(seq)
    lo, hi = GO2_MARGINS
    margins = np.arange(lo, hi + 1)
    base = float(pats["two"].mean())
    rows = {}
    for name, part in (("early", pats[~pats["late"]]), ("late", pats[pats["late"]])):
        counts = part.groupby("margin")["two"].agg(["sum", "size"]).reindex(
            np.arange(lo - 2, hi + 3), fill_value=0)
        tries = np.convolve(counts["sum"].to_numpy(float), GO2_KERNEL, mode="valid")
        total = np.convolve(counts["size"].to_numpy(float), GO2_KERNEL, mode="valid")
        prior_rate = float(part["two"].mean()) if len(part) else base
        weight = GO2_PRIOR * GO2_KERNEL.sum()
        smooth = (tries + weight * prior_rate) / (total + weight)
        rows[name] = [round(float(v), 3) for v in smooth]
        assert len(rows[name]) == len(margins)
    return {"margins": list(GO2_MARGINS), "rows": rows}


# --- halftime win probability -----------------------------------------------------------

def halftime_rows(seq: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Two rows per finished game (one per team): halftime margin, receive2h, spread, win."""
    first_half = seq[seq["game_half"].eq("Half1")]
    half = first_half.groupby("game_id").agg(
        home=("total_home_score", "last"), away=("total_away_score", "last"),
        home_opening=("home_opening_kickoff", "first"))
    g = games.set_index("game_id")[["home_score", "away_score", "spread_line"]]
    half = half.join(g, how="inner").dropna(subset=["home_score", "away_score", "spread_line"])
    half = half[half["home_score"] != half["away_score"]]
    home = pd.DataFrame({"margin": half["home"] - half["away"],
                         "receive2h": (half["home_opening"] != 1).astype(float),
                         "spread": half["spread_line"],
                         "win": (half["home_score"] > half["away_score"]).astype(float)})
    away = pd.DataFrame({"margin": -home["margin"], "receive2h": 1 - home["receive2h"],
                         "spread": -home["spread"], "win": 1 - home["win"]})
    return pd.concat([home, away], ignore_index=True)


def fit_halftime_wp(seq: pd.DataFrame, games: pd.DataFrame) -> dict:
    rows = halftime_rows(seq, games)
    X = np.c_[np.ones(len(rows)), rows[["margin", "receive2h", "spread"]].to_numpy(float)]
    coef = fit_logistic(X, rows["win"].to_numpy(), l2=1e-5)
    return {"features": HALFTIME_FEATURES, "coef": _rounded(coef)}
