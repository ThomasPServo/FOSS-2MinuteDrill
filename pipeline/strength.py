"""Team strength: EPA per play relative to the league over a team's trailing 17 games.

For a team and a spot game, the window is the team's 17 previous games (regular season
and playoffs, crossing seasons). Four numbers per team:

* ``off_pass`` / ``off_rush``: the team's EPA per dropback / designed run on offense,
* ``def_pass`` / ``def_rush``: EPA per play allowed on defense (negative = better),

each minus the league average over the same date range, then shrunk toward zero with
``shrunk = raw * n / (n + 300)`` where ``n`` is the number of plays.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

WINDOW_GAMES = 17
SHRINK_PLAYS = 300


class TeamWindows:
    """The dates of each team's previous games, for trailing-window lookups."""

    def __init__(self, games: pd.DataFrame):
        played = games.dropna(subset=["home_score", "away_score"])
        rows = pd.concat([
            played[["game_id", "gameday", "home_team"]].rename(columns={"home_team": "team"}),
            played[["game_id", "gameday", "away_team"]].rename(columns={"away_team": "team"}),
        ])
        self._dates = {team: sorted(g["gameday"].tolist()) for team, g in rows.groupby("team")}

    def start(self, team: str, date: str, n: int = WINDOW_GAMES) -> str:
        """Date of the earliest of the team's ``n`` games before ``date``."""
        prior = [d for d in self._dates.get(team, []) if d < date]
        return prior[-n] if len(prior) >= n else (prior[0] if prior else date)


def team_plays(lib: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Offensive snaps used for strength: real (not wiped-out) runs and passes, no tries."""
    plays = lib[(lib["two"] == 0) & (lib["play_type"] != "no_play")]
    plays = plays[["game_id", "posteam", "defteam", "kind", "epa"]].copy()
    plays["epa"] = plays["epa"] / 100
    dates = games.set_index("game_id")["gameday"]
    plays["date"] = plays["game_id"].map(dates)
    return plays.dropna(subset=["date"]).sort_values("date", kind="stable").reset_index(drop=True)


def team_strength(plays: pd.DataFrame, team: str, start: str, end: str) -> dict[str, float]:
    """Strength over [start, end); ``plays`` must be sorted by date (see ``team_plays``)."""
    lo, hi = np.searchsorted(plays["date"].to_numpy(), [start, end], side="left")
    window = plays.iloc[lo:hi]
    out = {}
    for side, col in (("off", "posteam"), ("def", "defteam")):
        for kind, label in (("pass", "pass"), ("run", "rush")):
            league = window[window["kind"] == kind]
            mine = league[league[col] == team]
            n = len(mine)
            raw = mine["epa"].mean() - league["epa"].mean() if n else 0.0
            out[f"{side}_{label}"] = round(float(raw * n / (n + SHRINK_PLAYS)), 4)
    return out
