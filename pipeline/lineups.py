"""The players in a spot: each team's offensive and defensive 11, kicker, punter, subs.

With participation data (2023-2025):

* the team with the ball uses its 11 from the spot's own snap, and the opponent's
  defense is the 11 from that same snap;
* the other two units (the team with the ball's defense, the opponent's offense) use
  that unit's most common personnel grouping in the game (e.g. 1 RB, 1 TE, 3 WR) and,
  within it, the most common exact 11. Fourth-quarter and end-of-half snaps count double.

Without participation (2026 so far) the 11s come from the game's snap counts and the
weekly roster: offense QB, RB, 3 WR, TE, 2 T, 2 G, C and defense 2 edge (DE), 2 interior
(DT/NT), 2 LB, 3 CB, 2 S, each slot taking the player with the most snaps at a matching
position (with fallbacks when a team is short at a position).

Kicker and punter are the team's kicker/punter in that game (else that season, else
the weekly roster). ``subs`` are the next skill players (RB, FB, WR, TE) by offensive
snaps in that game. Each team always has 22 distinct players in ``off`` + ``def``.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import pandas as pd

from .common import POSITION_GROUP, spot_position
from .roster import PlayerDirectory, clean_number

LATE_WEIGHT = 2
MAX_SUBS = 6
SKILL = {"RB", "FB", "WR", "TE"}

# (slot count, preferred positions, fallback positions)
OFFENSE_TEMPLATE = [
    (1, ["QB"], []), (1, ["RB", "HB"], ["FB", "WR"]), (3, ["WR"], ["TE", "RB", "FB"]),
    (1, ["TE"], ["FB", "WR"]), (2, ["T", "OT"], ["OL", "G", "C"]),
    (2, ["G", "OG"], ["OL", "T", "C"]), (1, ["C"], ["OL", "G", "T"]),
]
DEFENSE_TEMPLATE = [
    (2, ["DE", "EDGE"], ["OLB", "DL", "DT"]), (2, ["DT", "NT", "DL"], ["DE"]),
    (2, ["ILB", "MLB", "LB"], ["OLB"]), (3, ["CB"], ["DB", "S", "FS", "SS", "SAF"]),
    (2, ["FS", "SS", "S", "SAF"], ["DB", "CB"]),
]


@dataclass(frozen=True)
class Slot:
    gsis_id: str
    pos: str
    num: int | None


@dataclass
class TeamLineup:
    off: list[Slot]
    defense: list[Slot]
    k: Slot | None
    p: Slot | None
    subs: list[Slot]


def fill_template(ranked: list[tuple[str, str]], template) -> list[tuple[str, str]]:
    """Pick players (id, pos) for a position template from candidates ranked by snaps."""
    used: set[str] = set()
    picks: list[tuple[str, str]] = []
    need = [count for count, _, _ in template]
    for phase in (1, 2):
        for i, (_, preferred, fallback) in enumerate(template):
            allowed = preferred if phase == 1 else preferred + fallback
            for pid, pos in ranked:
                if need[i] == 0:
                    break
                if pid not in used and pos in allowed:
                    used.add(pid)
                    picks.append((pid, pos))
                    need[i] -= 1
    for pid, pos in ranked:  # still short (tiny rosters in the data): anyone left
        if len(picks) >= sum(c for c, _, _ in template):
            break
        if pid not in used:
            used.add(pid)
            picks.append((pid, pos))
    return picks


def _split(value) -> list[str]:
    return value.split(";") if isinstance(value, str) and value else []


def _personnel(lineup: list[tuple[str, str, str]]) -> tuple:
    """Personnel grouping of an 11: sorted (position group, count) pairs."""
    return tuple(sorted(Counter(POSITION_GROUP.get(pos, pos) for _, pos, _ in lineup).items()))


class LineupBuilder:
    def __init__(self, seq: pd.DataFrame, participation: pd.DataFrame, snaps: pd.DataFrame,
                 rosters: pd.DataFrame, directory: PlayerDirectory):
        self.directory = directory
        ran = (pd.to_numeric(seq["pass"], errors="coerce").eq(1)
               | pd.to_numeric(seq["rush"], errors="coerce").eq(1))
        scrimmage = seq[seq["play_type"].isin(["run", "pass"])
                        | (seq["play_type"].eq("no_play") & ran)]
        late = (scrimmage["qtr"].ge(4)
                | (scrimmage["qtr"].eq(2) & scrimmage["half_seconds_remaining"].le(120)))
        self._late = dict(zip(zip(scrimmage["game_id"], scrimmage["play_id"]), late))
        self._part = {}
        if not participation.empty:
            part = participation[[(g, p) in self._late for g, p in
                                  zip(participation["game_id"], participation["play_id"])]]
            self._part = {g: rows for g, rows in part.groupby("game_id")}

        snaps = snaps.assign(gsis_id=snaps["pfr_player_id"].map(directory.pfr_to_gsis))
        self._snaps = {k: v for k, v in snaps.dropna(subset=["gsis_id"])
                       .groupby(["game_id", "team"])}
        rosters = rosters.dropna(subset=["gsis_id"])
        self._roster = {k: v for k, v in rosters.groupby(["season", "week", "team"])}
        detail = rosters["depth_chart_position"].fillna(rosters["position"])
        self._roster_positions = dict(zip(
            zip(rosters["season"], rosters["week"], rosters["team"], rosters["gsis_id"]), detail))

        kicks = seq[seq["play_type"].isin(["field_goal", "extra_point"])]
        kickoffs = seq[seq["play_type"].eq("kickoff")]
        cols = ["game_id", "season", "team", "player"]
        self._kickers = pd.concat([
            kicks.rename(columns={"posteam": "team", "kicker_player_id": "player"})[cols],
            kickoffs.rename(columns={"defteam": "team", "kicker_player_id": "player"})[cols],
        ]).dropna()
        punts = seq[seq["play_type"].eq("punt")]
        self._punters = punts.rename(
            columns={"posteam": "team", "punter_player_id": "player"})[cols].dropna()

    # --- helpers ------------------------------------------------------------------------

    def _roster_pos(self, gsis_id: str, season: int, week: int, team: str) -> str | None:
        pos = self._roster_positions.get((season, week, team, gsis_id))
        return pos if isinstance(pos, str) else self.directory.position(gsis_id, season)

    def _slot(self, gsis_id: str, pos: str | None, num, season: int, fallback: str) -> Slot:
        number = clean_number(num)
        if number is None:
            number = self.directory.number(gsis_id, season)
        return Slot(gsis_id, spot_position(pos, fallback), number)

    def _ranked_snaps(self, game_id: str, team: str, unit: str, season: int,
                      week: int) -> list[tuple[str, str]]:
        """(id, roster position) of the team's players by offense/defense snaps."""
        rows = self._snaps.get((game_id, team))
        if rows is None:
            return []
        col = "offense_snaps" if unit == "off" else "defense_snaps"
        rows = rows[rows[col] > 0].sort_values(col, ascending=False)
        out = []
        for gsis_id, sc_pos in zip(rows["gsis_id"], rows["position"]):
            pos = self._roster_pos(gsis_id, season, week, team) or sc_pos
            out.append((gsis_id, pos))
        return out

    def _participation_unit(self, game_id: str, team: str, unit: str,
                            spot_play_id: int) -> list[tuple[str, str, str]] | None:
        """(id, pos, num) x 11 for a unit from participation, or None if unavailable."""
        rows = self._part.get(game_id)
        if rows is None:
            return None
        side = "offense" if unit == "off" else "defense"
        own_ball = rows["possession_team"] == team
        rows = rows[own_ball if unit == "off" else ~own_ball]

        def unpack(row):
            ids = _split(row[f"{side}_players"])
            pos = _split(row.get(f"{side}_positions"))
            nums = _split(row.get(f"{side}_numbers"))
            if len(ids) != 11 or len(pos) != 11:
                return None
            if unit == "off" and "QB" not in pos:
                return None
            if unit == "def" and ({"K", "P", "LS"} & set(pos)):
                return None
            nums = nums if len(nums) == 11 else [None] * 11
            return list(zip(ids, pos, nums))

        spot = rows[rows["play_id"] == spot_play_id]  # empty unless this unit is on for it
        if len(spot):
            lineup = unpack(spot.iloc[0])
            if lineup:
                return lineup
        personnel: Counter = Counter()
        sets: Counter = Counter()
        last: dict[frozenset, list] = {}
        for _, row in rows.iterrows():
            lineup = unpack(row)
            if not lineup:
                continue
            weight = LATE_WEIGHT if self._late.get((game_id, row["play_id"])) else 1
            key = frozenset(pid for pid, _, _ in lineup)
            personnel[_personnel(lineup)] += weight
            sets[key] += weight
            last[key] = lineup
        if not sets:
            return None
        grouping = max(personnel.items(), key=lambda kv: kv[1])[0]
        best = max(((key, n) for key, n in sets.items()
                    if _personnel(last[key]) == grouping), key=lambda kv: kv[1])[0]
        return last[best]

    def _specialist(self, table: pd.DataFrame, game_id: str, season: int, team: str,
                    week: int, roster_pos: str) -> str | None:
        game = table[(table["game_id"] == game_id) & (table["team"] == team)]
        if len(game):
            return game["player"].mode().iat[0]
        roster = self._roster.get((season, week, team))
        if roster is not None:
            match = roster[roster["position"].eq(roster_pos) & roster["status"].eq("ACT")]
            if len(match):
                return match["gsis_id"].iat[0]
        season_rows = table[(table["season"] == season) & (table["team"] == team)]
        return season_rows["player"].mode().iat[0] if len(season_rows) else None

    # --- public -------------------------------------------------------------------------

    def team_lineup(self, game_id: str, season: int, week: int, team: str,
                    spot_play_id: int) -> TeamLineup:
        """Lineup for ``team`` in the spot whose snap is ``spot_play_id``.

        The spot snap supplies the unit that is on the field for it (the offense of the
        team with the ball, the defense of the other team); other units are picked from
        the whole game.
        """
        units = {}
        for unit, template in (("off", OFFENSE_TEMPLATE), ("def", DEFENSE_TEMPLATE)):
            ranked = self._ranked_snaps(game_id, team, unit, season, week)
            lineup = self._participation_unit(game_id, team, unit, spot_play_id)
            if lineup is None:
                lineup = [(pid, pos, None) for pid, pos in fill_template(ranked, template)]
            units[unit] = (lineup, ranked)

        off = [self._slot(pid, pos, num, season, "WR") for pid, pos, num in units["off"][0]]
        used = {s.gsis_id for s in off}
        defense = [self._slot(pid, pos, num, season, "CB")
                   for pid, pos, num in units["def"][0] if pid not in used]
        used |= {s.gsis_id for s in defense}
        for unit, players, fallback in (("off", off, "WR"), ("def", defense, "CB")):
            for pid, pos in units[unit][1]:  # top up (two-way players, short data)
                if len(players) >= 11:
                    break
                if pid not in used:
                    players.append(self._slot(pid, pos, None, season, fallback))
                    used.add(pid)

        subs = []
        for pid, pos in units["off"][1]:
            if len(subs) >= MAX_SUBS:
                break
            slot = self._slot(pid, pos, None, season, "WR")
            if pid not in used and slot.pos in SKILL:
                subs.append(slot)
                used.add(pid)

        kicker = self._specialist(self._kickers, game_id, season, team, week, "K")
        punter = self._specialist(self._punters, game_id, season, team, week, "P")
        return TeamLineup(
            off=off, defense=defense, subs=subs,
            k=self._slot(kicker, "K", None, season, "K") if kicker else None,
            p=self._slot(punter, "P", None, season, "P") if punter else None)
