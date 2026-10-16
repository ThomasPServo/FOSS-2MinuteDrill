"""``coaches.json``: how real head coaches call late-game situations.

Late game = 4th quarter with <= 5:00 left, or 2nd quarter with <= 2:00 left, with the
score within 16 (for two-point decisions: the score before the touchdown). Measures:

* ``pass``: share of called runs/passes that were passes (scrambles and sacks count as
  passes; plays wiped out by penalties and two-point tries are left out);
* ``deep``: share of thrown passes with 15+ air yards;
* ``go``: share of fourth-and-5-or-less in opponent territory (``yl < 50``) where they
  went for it rather than kicking;
* ``two``: share of touchdowns followed by a two-point try.

A measure is ``null`` when the coach never faced that situation. ``league`` holds the
mean and standard deviation of each measure over coaches with at least 100 late-game
snaps.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import models
from .common import FL_NO_PLAY, FL_SACK, FL_SCRAMBLE

COACHES_VERSION = 1
MEASURES = ["pass", "deep", "go", "two"]
MAX_MARGIN = 16
MIN_SNAPS_FOR_LEAGUE = 100


def late_game(df: pd.DataFrame, margin: pd.Series) -> pd.Series:
    late = ((df["qtr"].eq(4) & df["game_seconds_remaining"].le(300))
            | (df["qtr"].eq(2) & df["half_seconds_remaining"].le(120)))
    return late & margin.abs().le(MAX_MARGIN)


def _coach_of(df: pd.DataFrame, games: pd.DataFrame) -> pd.Series:
    g = games.set_index("game_id")
    home = df["game_id"].map(g["home_team"])
    return pd.Series(np.where(df["posteam"].eq(home), df["game_id"].map(g["home_coach"]),
                              df["game_id"].map(g["away_coach"])), index=df.index)


def build_coaches(seq: pd.DataFrame, lib: pd.DataFrame, games: pd.DataFrame,
                  seasons: list[int]) -> dict:
    plays = lib[(lib["two"] == 0) & ((lib["fl"] & FL_NO_PLAY) == 0)]
    plays = plays[late_game(plays, plays["score_differential"])].copy()
    plays["coach"] = _coach_of(plays, games)
    plays["is_pass"] = plays["kind"].eq("pass")
    thrown = plays["is_pass"] & ((plays["fl"] & (FL_SACK | FL_SCRAMBLE)) == 0)
    plays["deep"] = np.where(thrown, (plays["air"] >= 15).astype(float), np.nan)

    fourth = models.fourth_decisions(seq)
    fourth = fourth[late_game(fourth, fourth["score_differential"])
                    & fourth["ydstogo"].le(5) & fourth["yardline_100"].lt(50)].copy()
    fourth["coach"] = _coach_of(fourth, games)
    fourth["go"] = fourth["decision"].eq(0).astype(float)

    pats = models.pat_decisions(seq)
    pats = pats[late_game(pats, pats["margin"] - 6)].copy()
    pats["coach"] = _coach_of(pats, games)

    measures = pd.DataFrame({
        "n": plays.groupby("coach").size(),
        "pass": plays.groupby("coach")["is_pass"].mean(),
        "deep": plays.groupby("coach")["deep"].mean(),
        "go": fourth.groupby("coach")["go"].mean(),
        "two": pats.groupby("coach")["two"].mean(),
    })
    measures["n"] = measures["n"].fillna(0).astype(int)

    played = games[games["season"].isin(seasons) & games["home_score"].notna()]
    tenure = pd.concat([
        played[["season", "home_team", "home_coach"]].set_axis(["season", "team", "coach"], axis=1),
        played[["season", "away_team", "away_coach"]].set_axis(["season", "team", "coach"], axis=1),
    ])
    coaches = []
    for coach, rows in tenure.groupby("coach"):
        m = measures.loc[coach] if coach in measures.index else None
        entry = {"name": coach, "teams": list(dict.fromkeys(rows.sort_values("season")["team"])),
                 "from": int(rows["season"].min()), "to": int(rows["season"].max()),
                 "n": int(m["n"]) if m is not None else 0}
        for key in MEASURES:
            value = m[key] if m is not None else np.nan
            entry[key] = None if pd.isna(value) else round(float(value), 3)
        coaches.append(entry)

    regulars = measures[measures["n"] >= MIN_SNAPS_FOR_LEAGUE]
    league = {key: {"mean": round(float(regulars[key].mean()), 4),
                    "sd": round(float(regulars[key].std()), 4)} for key in MEASURES}
    return {"version": COACHES_VERSION, "measures": MEASURES, "league": league,
            "coaches": coaches}
