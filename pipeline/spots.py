"""Spots: real late-game situations the player takes over, and the daily schedule.

Candidates (spot seasons only, regular season and playoffs):

* **drill / protect / tight** - the first snap of an offensive drive (first down, not a
  kneel, field goal or punt) with at least 20 seconds left in the half:
  drill = 4th quarter, <= 5:00 left, offense trails by 1-8; protect = same but leads by
  1-8; tight = tied in the 4th quarter with <= 5:00 left, or 2nd quarter with <= 2:00
  left and the score within 8.
* **q4** (survivor) - the first scrimmage snap of the 4th quarter when the score is
  within 10. The coached team is the trailing team (the team with the ball if tied).

Selection: when more candidates qualify than ``DAILY_QUOTA`` / ``Q4_QUOTA``, each
candidate gets a score (closer margins first; for daily spots also time pressure,
peaking at about 1:40 left in the game or 1:00 before the half) and the pick is spread
over seasons (in proportion to their candidates) and teams (round-robin by score).

The daily schedule is a seeded shuffle of the drill/protect/tight spots followed by a
greedy pass that avoids the same team, category or season on consecutive days.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .common import POSITION_GROUP, none_if_nan
from .strength import team_strength

SPOT_VERSION = 1
LAUNCH = "2026-10-16"
CATEGORIES = {"drill": "Two-minute drill", "protect": "Protect the lead",
              "tight": "Tied, or the end of the half", "q4": "Fourth quarter"}
DAILY_QUOTA = {"drill": 380, "protect": 200, "tight": 220}
Q4_QUOTA = 300
MIN_SECONDS = 20
SCHEDULE_SEED = 2026
SCHEDULE_LOOKAHEAD = 60
DRIVE_START_TYPES = ["run", "pass", "no_play", "qb_spike"]


def _first_snaps(seq: pd.DataFrame, seasons: list[int]) -> pd.DataFrame:
    two = pd.to_numeric(seq["two_point_attempt"], errors="coerce").fillna(0).eq(1)
    return seq[seq["is_snap"] & seq["season"].isin(seasons) & ~two
               & ~seq["play_type"].isin(["kickoff", "extra_point"])]


def drive_start_candidates(seq: pd.DataFrame, seasons: list[int]) -> pd.DataFrame:
    snaps = _first_snaps(seq, seasons)
    first = snaps.groupby(["game_id", "fixed_drive"], sort=False).head(1)
    first = first[first["down"].eq(1) & first["play_type"].isin(DRIVE_START_TYPES)
                  & first["half_seconds_remaining"].ge(MIN_SECONDS)].copy()
    m = first["score_differential"]
    gsr = first["game_seconds_remaining"]
    hs = first["half_seconds_remaining"]
    late4 = first["qtr"].eq(4) & gsr.le(300)
    end_half = first["qtr"].eq(2) & hs.le(120) & m.abs().le(8)
    first["cat"] = np.select(
        [late4 & m.between(-8, -1), late4 & m.between(1, 8), late4 & m.eq(0), end_half],
        ["drill", "protect", "tight", "tight"], default="")
    first = first[first["cat"] != ""].copy()

    m = first["score_differential"].abs()
    closeness = np.where(m.eq(0), 1.0, 1 - (m - 1) / 8)
    pressure = np.where(first["qtr"].eq(4),
                        1 - (first["game_seconds_remaining"] - 100).abs() / 200,
                        1 - (first["half_seconds_remaining"] - 60).abs() / 120)
    tied_q4 = first["qtr"].eq(4) & first["score_differential"].eq(0)
    first["score"] = 0.6 * closeness + 0.4 * np.clip(pressure, 0, 1) + tied_q4.astype(float)
    first["team"] = first["posteam"]
    return first


def q4_candidates(seq: pd.DataFrame, seasons: list[int]) -> pd.DataFrame:
    snaps = _first_snaps(seq, seasons)
    first = snaps[snaps["qtr"].eq(4)].groupby("game_id", sort=False).head(1).copy()
    m = first["score_differential"]
    first = first[m.abs().le(10)].copy()
    m = first["score_differential"]
    first["cat"] = "q4"
    first["team"] = np.where(m > 0, first["defteam"], first["posteam"])
    first["score"] = 1 - m.abs() / 11
    return first


def balanced_pick(cands: pd.DataFrame, n: int) -> pd.DataFrame:
    """Pick ``n`` candidates: per-season quotas, then team round-robin by score."""
    if len(cands) <= n:
        return cands
    cands = cands.sort_values(["score", "game_id", "play_id"], ascending=[False, True, True])
    sizes = cands.groupby("season").size()
    raw = sizes / sizes.sum() * n
    quota = np.floor(raw).astype(int)
    for season in (raw - quota).sort_values(ascending=False).index[: n - quota.sum()]:
        quota[season] += 1
    picked = []
    for season, group in cands.groupby("season"):
        queues = {team: list(rows.index) for team, rows in group.groupby("team", sort=False)}
        order = sorted(queues, key=lambda t: -group.loc[queues[t][0], "score"])
        take = []
        while len(take) < quota[season] and any(queues.values()):
            for team in order:
                if queues[team] and len(take) < quota[season]:
                    take.append(queues[team].pop(0))
        picked.extend(take)
    return cands.loc[picked]


def select_spots(seq: pd.DataFrame, seasons: list[int]) -> pd.DataFrame:
    drives = drive_start_candidates(seq, seasons)
    parts = [balanced_pick(drives[drives["cat"] == cat], quota)
             for cat, quota in DAILY_QUOTA.items()]
    parts.append(balanced_pick(q4_candidates(seq, seasons), Q4_QUOTA))
    spots = pd.concat(parts)
    spots["id"] = spots["game_id"] + "_" + spots["play_id"].astype(str)
    return spots.drop_duplicates("id").sort_values(["game_date", "game_id", "play_id"])


def daily_schedule(entries: list[dict], seed: int = SCHEDULE_SEED) -> list[str]:
    """Seeded shuffle, then greedily avoid repeats of team/category/season on adjacent days."""
    rng = np.random.default_rng(seed)
    remaining = [entries[i] for i in rng.permutation(len(entries))]

    def conflict(a: dict | None, b: dict) -> int:
        if a is None:
            return 0
        return (4 * (a["team"] == b["team"] or {a["home"], a["away"]} == {b["home"], b["away"]})
                + 2 * (a["cat"] == b["cat"]) + 1 * (a["season"] == b["season"]))

    out: list[dict] = []
    while remaining:
        prev = out[-1] if out else None
        best = min(range(min(len(remaining), SCHEDULE_LOOKAHEAD)),
                   key=lambda i: (conflict(prev, remaining[i]), i))
        out.append(remaining.pop(best))
    return [e["id"] for e in out]


def survivor_order(entries: list[dict], seed: int = SCHEDULE_SEED + 1) -> list[str]:
    rng = np.random.default_rng(seed)
    return [entries[i]["id"] for i in rng.permutation(len(entries))]


class SpotContext:
    """Everything needed to write spot files (game info, lineups, ratings, speeds)."""

    def __init__(self, seq, games, calls_by_play, lineups, ratings, speeds, strength_plays,
                 windows, directory):
        self.games = games.set_index("game_id")
        self.calls_by_play = calls_by_play
        self.lineups = lineups
        self.ratings = ratings
        self.speeds = speeds
        self.strength_plays = strength_plays
        self.windows = windows
        self.directory = directory
        kick2h = seq[seq["play_type"].eq("kickoff") & seq["game_half"].eq("Half2")]
        self.receive2h = kick2h.groupby("game_id")["posteam"].first().to_dict()
        outdoor = games[~games["roof"].isin(["dome", "closed"])].copy()
        month = outdoor["gameday"].str[5:7]
        self.month_temp = outdoor.groupby(month)["temp"].median().to_dict()
        self.month_wind = outdoor.groupby(month)["wind"].median().to_dict()

    def _weather(self, game) -> tuple[bool, int, int]:
        """(indoor, temp F, wind mph). Indoors is 72 F and calm; missing outdoor readings
        get the median outdoor value for that calendar month."""
        indoor = game["roof"] in ("dome", "closed")
        month = game["gameday"][5:7]
        if indoor:
            return True, 72, 0
        temp = game["temp"] if pd.notna(game["temp"]) else self.month_temp.get(month, 60)
        wind = game["wind"] if pd.notna(game["wind"]) else self.month_wind.get(month, 8)
        return False, int(round(temp)), int(round(wind))

    def _player(self, slot, season: int, start: str, end: str) -> dict:
        group = POSITION_GROUP.get(slot.pos, "WR")
        return {"id": slot.gsis_id, "name": self.directory.name(slot.gsis_id),
                "short": self.directory.short(slot.gsis_id), "pos": slot.pos, "num": slot.num,
                "r": self.ratings.rating(slot.gsis_id, group, start, end),
                "spd": self.speeds.speed(slot.gsis_id, season, group)}

    def build(self, row) -> tuple[dict, dict]:
        """Return (index entry, spot file) for a selected spot row."""
        game_id = row["game_id"]
        game = self.games.loc[game_id]
        season, week = int(row["season"]), int(row["week"])
        home, away = row["home_team"], row["away_team"]
        date = game["gameday"]
        score = {home: int(row["total_home_score"]), away: int(row["total_away_score"])}
        receive2h = self.receive2h.get(game_id)
        if receive2h is None:
            receive2h = away if row["home_opening_kickoff"] == 1 else home
        indoor, temp, wind = self._weather(game)

        players, strength = {}, {}
        for team in (home, away):
            start = self.windows.start(team, date)
            lineup = self.lineups.team_lineup(game_id, season, week, team, int(row["play_id"]))

            def player(slot, start=start):
                return self._player(slot, season, start, date) if slot else None

            players[team] = {"off": [player(s) for s in lineup.off],
                             "def": [player(s) for s in lineup.defense],
                             "k": player(lineup.k), "p": player(lineup.p),
                             "subs": [player(s) for s in lineup.subs]}
            strength[team] = team_strength(self.strength_plays, team, start, date)

        common = {"id": row["id"], "cat": row["cat"], "season": season, "week": week,
                  "type": row["season_type"], "date": date, "home": home, "away": away,
                  "team": row["team"]}
        index_entry = {**common, "qtr": int(row["qtr"]),
                       "clock": int(row["quarter_seconds_remaining"]), "score": score,
                       "yl": int(row["yardline_100"])}
        spot = {
            "version": SPOT_VERSION, "id": row["id"], "cat": row["cat"], "game_id": game_id,
            "play_id": int(row["play_id"]), "season": season, "week": week,
            "type": row["season_type"], "date": date, "home": home, "away": away,
            "team": row["team"], "roof": game["roof"], "indoor": indoor, "temp": temp,
            "wind": wind, "spread": float(game["spread_line"]),
            "start": {"qtr": int(row["qtr"]), "clock": int(row["quarter_seconds_remaining"]),
                      "score": score, "pos": row["posteam"], "down": int(row["down"]),
                      "ytg": int(row["ydstogo"]), "yl": int(row["yardline_100"]),
                      "to": {home: int(row["home_timeouts_remaining"]),
                             away: int(row["away_timeouts_remaining"])},
                      "receive2h": receive2h, "phase": "snap"},
            "real": {"coach": {home: game["home_coach"], away: game["away_coach"]},
                     "call": self.calls_by_play.get((game_id, int(row["play_id"]))),
                     "drive": none_if_nan(row["fixed_drive_result"]),
                     "final": {home: int(game["home_score"]), away: int(game["away_score"])},
                     "desc": row["desc"]},
            "strength": strength,
            "players": players,
        }
        return index_entry, spot
