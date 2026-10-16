"""Player ratings (40-99) from production over a trailing window.

Method
------
For a team and a spot game, the window is the team's 17 previous games (crossing
seasons, see ``strength.TeamWindows``); every player's production is summed over all of
his games in that date range, whichever team he played for.

Each position group (QB, RB, WR, TE, OL, DL, LB, CB, S, K, P) has a few production
metrics. Rate metrics are shrunk toward a below-average prior (the 30th percentile of
regular players in the window) with ``(total + k * prior) / (volume + k)``, so a backup
with a handful of good plays does not look elite. Every group also has a volume term
(snap share or touches per team game), so starters rank above spot players. The
metrics are z-scored within the group's population (players with a meaningful role in
the window), combined with the weights in ``GROUPS`` into a score, and the player's
rating is his percentile of that score within the population:

    r = round(40 + 59 * percentile)        (players outside the population included)

Metrics:

* QB: EPA per play (dropbacks and runs, shrunk k=150) and CPOE (k=150), plays per game.
* RB: rushing EPA per carry (k=60), NGS rush yards over expected per attempt (k=60),
  receiving yards per game, touches per game.
* WR/TE: receiving EPA per target (k=40), receiving yards per game, NGS separation and
  YAC over expected (k=40), offensive snap share.
* OL: offensive snap share, his team's sack rate (lower is better) and rushing EPA in
  the games he played (k=200 plays).
* DL/LB: (2 x sacks + QB hits + tackles for loss) and tackles per defensive snap
  (k=300 snaps), defensive snap share.
* CB/S: (2 x interceptions + passes defended) and tackles per defensive snap (k=300),
  defensive snap share.
* K: field goals made over expectation per attempt using the ``special.fg`` model
  (k=15), attempts per game. P: net yards per punt (k=20).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import models
from .common import FL_SACK
from .roster import PlayerDirectory

WINDOW_TEAM_GAMES = 17
PRIOR_PERCENTILE = 30
R_MIN, R_MAX = 40, 99


@dataclass(frozen=True)
class Metric:
    """One rating input, weighted by ``weight`` in the group score.

    With ``total``/``volume`` the value is the shrunk rate
    ``(total + k * prior) / (volume + k)``. Without them it is the column ``name`` summed
    over the window and divided by the window's 17 team games (summed per-game snap
    percentages become a snap share).
    """

    name: str
    weight: float
    total: str | None = None
    volume: str | None = None
    k: float = 0.0
    sign: float = 1.0  # -1 when lower is better


GROUPS: dict[str, list[Metric]] = {
    "QB": [Metric("epa_play", .55, "qb_epa", "qb_plays", 150),
           Metric("cpoe", .25, "cpoe_w", "attempts", 150),
           Metric("qb_plays", .20)],
    "RB": [Metric("rush_epa", .35, "rushing_epa", "carries", 60),
           Metric("ryoe", .25, "ryoe_w", "ngs_rush_att", 60),
           Metric("receiving_yards", .15),
           Metric("touches", .25)],
    "WR": [Metric("rec_epa", .30, "receiving_epa", "targets", 40),
           Metric("receiving_yards", .35),
           Metric("separation", .10, "sep_w", "ngs_targets", 40),
           Metric("yacoe", .10, "yacoe_w", "ngs_targets", 40),
           Metric("offense_pct", .15)],
    "OL": [Metric("offense_pct", .60),
           Metric("team_sack_rate", .20, "team_sacks", "team_dropbacks", 200, sign=-1),
           Metric("team_rush_epa", .20, "team_rush_epa_sum", "team_rushes", 200)],
    "DL": [Metric("pressure", .45, "pressure_events", "defense_snaps", 300),
           Metric("tackling", .15, "tackles", "defense_snaps", 300),
           Metric("defense_pct", .40)],
    "LB": [Metric("pressure", .25, "pressure_events", "defense_snaps", 300),
           Metric("tackling", .35, "tackles", "defense_snaps", 300),
           Metric("defense_pct", .40)],
    "CB": [Metric("ball", .45, "ball_events", "defense_snaps", 300),
           Metric("tackling", .10, "tackles", "defense_snaps", 300),
           Metric("defense_pct", .45)],
    "S": [Metric("ball", .35, "ball_events", "defense_snaps", 300),
          Metric("tackling", .20, "tackles", "defense_snaps", 300),
          Metric("defense_pct", .45)],
    "K": [Metric("fg_oe", .80, "fg_over_exp", "fg_att", 15),
          Metric("fg_att", .20)],
    "P": [Metric("net", 1.0, "punt_net", "punts", 20)],
}
GROUPS["TE"] = GROUPS["WR"]

# Who counts as a regular at the group (the percentile population and prior), per window.
POPULATION = {
    "QB": ("qb_plays", 100), "RB": ("touches", 40), "WR": ("offense_pct", 2.5),
    "TE": ("offense_pct", 2.5), "OL": ("offense_pct", 4.0), "DL": ("defense_pct", 3.0),
    "LB": ("defense_pct", 3.0), "CB": ("defense_pct", 3.0), "S": ("defense_pct", 3.0),
    "K": ("fg_att", 8), "P": ("punts", 20),
}

SUM_COLUMNS = [
    "qb_epa", "qb_plays", "attempts", "cpoe_w", "carries", "rushing_epa", "ryoe_w",
    "ngs_rush_att", "receiving_yards", "touches", "targets", "receiving_epa", "sep_w",
    "yacoe_w", "ngs_targets", "offense_pct", "defense_pct", "defense_snaps",
    "pressure_events", "tackles", "ball_events", "fg_att", "fg_over_exp", "punts",
    "punt_net", "team_sacks", "team_dropbacks", "team_rush_epa_sum", "team_rushes",
]


def _ngs_weekly(ngs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Weekly NGS rows keyed by (gsis_id, season, week) with attempt-weighted totals."""
    rush = ngs["rushing"].assign(
        ngs_rush_att=lambda d: d["rush_attempts"],
        ryoe_w=lambda d: d["rush_yards_over_expected_per_att"] * d["rush_attempts"])
    rec = ngs["receiving"].assign(
        ngs_targets=lambda d: d["targets"],
        sep_w=lambda d: d["avg_separation"] * d["targets"],
        yacoe_w=lambda d: d["avg_yac_above_expectation"] * d["targets"])
    keys = ["player_gsis_id", "season", "week"]
    out = pd.merge(rush[keys + ["ngs_rush_att", "ryoe_w"]],
                   rec[keys + ["ngs_targets", "sep_w", "yacoe_w"]], on=keys, how="outer")
    out = out.groupby(keys, as_index=False).sum(min_count=1)
    return out.rename(columns={"player_gsis_id": "gsis_id"})


def player_games(stats: pd.DataFrame, snaps: pd.DataFrame, seq: pd.DataFrame,
                 lib: pd.DataFrame, ngs: dict[str, pd.DataFrame], games: pd.DataFrame,
                 directory: PlayerDirectory, fg_coef: list[float]) -> pd.DataFrame:
    """One row per (player, game) with the summable production columns and a date."""
    s = stats.rename(columns={"player_id": "gsis_id"})

    def num(col: str) -> pd.Series:
        return pd.to_numeric(s[col], errors="coerce").fillna(0)

    pg = pd.DataFrame({
        "gsis_id": s["gsis_id"], "game_id": s["game_id"], "season": s["season"],
        "week": s["week"], "team": s["team"],
        "qb_epa": num("passing_epa") + num("rushing_epa").where(num("attempts") > 0, 0),
        "qb_plays": (num("attempts") + num("sacks_suffered")
                     + num("carries").where(num("attempts") > 0, 0)),
        "attempts": num("attempts"),
        "cpoe_w": num("passing_cpoe") * num("attempts"),
        "carries": num("carries"), "rushing_epa": num("rushing_epa"),
        "receiving_yards": num("receiving_yards"), "targets": num("targets"),
        "receiving_epa": num("receiving_epa"),
        "touches": num("carries") + num("targets"),
        "pressure_events": 2 * num("def_sacks") + num("def_qb_hits") + num("def_tackles_for_loss"),
        "tackles": num("def_tackles_solo") + 0.5 * num("def_tackle_assists"),
        "ball_events": 2 * num("def_interceptions") + num("def_pass_defended"),
        "punts": num("pt_att"), "punt_net": num("pt_net_yards"),
    })

    # Snap counts (PFR ids -> GSIS ids). Percentages are summed: / team games = share.
    sc = snaps.assign(gsis_id=snaps["pfr_player_id"].map(directory.pfr_to_gsis))
    sc = sc.dropna(subset=["gsis_id"]).groupby(["gsis_id", "game_id"], as_index=False).agg(
        offense_pct=("offense_pct", "sum"), defense_pct=("defense_pct", "sum"),
        defense_snaps=("defense_snaps", "sum"), team_sc=("team", "first"),
        season_sc=("season", "first"), week_sc=("week", "first"))
    pg = pg.merge(sc, on=["gsis_id", "game_id"], how="outer")
    pg["team"] = pg["team"].fillna(pg["team_sc"])
    pg["season"] = pg["season"].fillna(pg["season_sc"])
    pg["week"] = pg["week"].fillna(pg["week_sc"])
    pg = pg.drop(columns=["team_sc", "season_sc", "week_sc"])

    # Field goals over expectation and attempts, from the play-by-play.
    kicks = seq[seq["play_type"].eq("field_goal") & seq["field_goal_result"].notna()]
    indoor, wind = models.game_wind(kicks)
    expected = 1 / (1 + np.exp(-(models.fg_features(kicks["yardline_100"], indoor, wind)
                                 @ np.asarray(fg_coef))))
    fg = pd.DataFrame({"gsis_id": kicks["kicker_player_id"].to_numpy(),
                       "game_id": kicks["game_id"].to_numpy(),
                       "fg_att": 1.0,
                       "fg_over_exp": kicks["field_goal_result"].eq("made").to_numpy() - expected})
    fg = fg.dropna(subset=["gsis_id"]).groupby(["gsis_id", "game_id"], as_index=False).sum()
    pg = pg.merge(fg, on=["gsis_id", "game_id"], how="left")

    # Team context for linemen: sacks per dropback and rush EPA in each game.
    plays = lib[(lib["two"] == 0) & (lib["play_type"] != "no_play")]
    is_run = plays["kind"].eq("run")
    team_game = pd.DataFrame({
        "game_id": plays["game_id"], "team": plays["posteam"],
        "team_dropbacks": (~is_run).astype(float),
        "team_sacks": ((plays["fl"] & FL_SACK) > 0).astype(float),
        "team_rushes": is_run.astype(float),
        "team_rush_epa_sum": np.where(is_run, plays["epa"] / 100, 0.0),
    }).groupby(["game_id", "team"], as_index=False).sum()
    pg = pg.merge(team_game, on=["game_id", "team"], how="left")
    played_offense = pg["offense_pct"].fillna(0) > 0
    for col in ("team_dropbacks", "team_sacks", "team_rushes", "team_rush_epa_sum"):
        pg[col] = pg[col].where(played_offense, 0)

    pg = pg.dropna(subset=["gsis_id", "season", "week"])
    pg[["season", "week"]] = pg[["season", "week"]].astype(int)
    pg = pg.merge(_ngs_weekly(ngs), on=["gsis_id", "season", "week"], how="left")
    pg["date"] = pg["game_id"].map(games.set_index("game_id")["gameday"])
    pg = pg.dropna(subset=["date"])
    pg[SUM_COLUMNS] = pg[SUM_COLUMNS].fillna(0).astype(float)
    return pg[["gsis_id", "game_id", "date", "season", "team", *SUM_COLUMNS]].reset_index(drop=True)


class Ratings:
    """Window-cached rating lookups."""

    def __init__(self, player_games: pd.DataFrame, directory: PlayerDirectory):
        self.pg = player_games.sort_values("date", kind="stable").reset_index(drop=True)
        self._dates = self.pg["date"].to_numpy()
        self.directory = directory
        self._windows: dict[tuple[str, str], dict] = {}

    def _window(self, start: str, end: str) -> dict:
        key = (start, end)
        if key in self._windows:
            return self._windows[key]
        lo, hi = np.searchsorted(self._dates, [start, end], side="left")
        rows = self.pg.iloc[lo:hi]
        totals = rows.groupby("gsis_id")[SUM_COLUMNS].sum()
        season = int(rows["season"].max()) if len(rows) else int(end[:4])
        groups = np.array([self.directory.group(pid, season) for pid in totals.index])
        matrix = totals.to_numpy(float)
        result = {"row": {pid: i for i, pid in enumerate(totals.index)}, "matrix": matrix,
                  "groups": {}}
        for group, metrics in GROUPS.items():
            pop_col, pop_min = POPULATION[group]
            in_pop = (groups == group) & (matrix[:, SUM_COLUMNS.index(pop_col)] >= pop_min)
            if in_pop.sum() < 5:
                result["groups"][group] = None
                continue
            population = {c: matrix[in_pop, j] for j, c in enumerate(SUM_COLUMNS)}
            priors = {m.name: np.percentile(self._raw_rate(population, m), PRIOR_PERCENTILE)
                      for m in metrics if m.total}
            values = self._metric_values(population, metrics, priors)
            stats = {name: (v.mean(), v.std() or 1.0) for name, v in values.items()}
            score = self._score(values, metrics, stats)
            result["groups"][group] = {"priors": priors, "stats": stats,
                                       "scores": np.sort(score)}
        self._windows[key] = result
        return result

    @staticmethod
    def _raw_rate(frame: dict, m: Metric) -> np.ndarray:
        """Unshrunk rate for players with any volume (for the prior percentile)."""
        volume = np.asarray(frame[m.volume], dtype=float)
        total = np.asarray(frame[m.total], dtype=float)
        has = volume > 0
        return total[has] / volume[has] if has.any() else np.zeros(1)

    @staticmethod
    def _metric_values(frame: dict, metrics: list[Metric], priors: dict) -> dict:
        """Metric values from column totals (arrays for a population, scalars for one player)."""
        values = {}
        for m in metrics:
            if m.total:
                total = np.asarray(frame[m.total], dtype=float)
                volume = np.asarray(frame[m.volume], dtype=float)
                values[m.name] = (total + m.k * priors[m.name]) / (volume + m.k)
            else:
                values[m.name] = np.asarray(frame[m.name], dtype=float) / WINDOW_TEAM_GAMES
        return values

    @staticmethod
    def _score(values: dict, metrics: list[Metric], stats: dict) -> np.ndarray:
        score = 0.0
        for m in metrics:
            mean, sd = stats[m.name]
            score = score + m.weight * m.sign * (values[m.name] - mean) / sd
        return np.asarray(score, float)

    def rating(self, gsis_id: str, group: str, start: str, end: str) -> int:
        window = self._window(start, end)
        info = window["groups"].get(group)
        if info is None:
            return 60
        metrics = GROUPS[group]
        i = window["row"].get(gsis_id)
        totals = dict(zip(SUM_COLUMNS, window["matrix"][i] if i is not None
                          else np.zeros(len(SUM_COLUMNS))))
        values = self._metric_values(totals, metrics, info["priors"])
        score = float(self._score(values, metrics, info["stats"]))
        scores = info["scores"]
        below = np.searchsorted(scores, score, side="left")
        ties = np.searchsorted(scores, score, side="right") - below
        percentile = (below + 0.5 * ties) / len(scores)
        return int(np.clip(round(R_MIN + (R_MAX - R_MIN) * percentile), R_MIN, R_MAX))
