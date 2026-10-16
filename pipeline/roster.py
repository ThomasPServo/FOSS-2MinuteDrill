"""Player directory: names, short names, jersey numbers and positions by season.

Built from nflverse ``players.parquet`` (one row per player, latest info) and the weekly
rosters (position and jersey number as of each week). Weekly roster positions win over
the players table because players change positions and numbers over time.
"""

from __future__ import annotations

import pandas as pd

from .common import POSITION_GROUP, spot_position


def clean_number(value) -> int | None:
    """Jersey number as an int (0-99), or None if missing or invalid."""
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if 0 <= number <= 99 else None


class PlayerDirectory:
    def __init__(self, players: pd.DataFrame, rosters: pd.DataFrame):
        players = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id")
        self._info = players.set_index("gsis_id")[
            ["display_name", "short_name", "first_name", "last_name", "position",
             "jersey_number"]].to_dict("index")

        pfr = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id")
        self.pfr_to_gsis = dict(zip(pfr["pfr_id"], pfr["gsis_id"]))
        extra = rosters.dropna(subset=["pfr_id", "gsis_id"]).drop_duplicates("pfr_id")
        for pfr_id, gsis in zip(extra["pfr_id"], extra["gsis_id"]):
            self.pfr_to_gsis.setdefault(pfr_id, gsis)

        rosters = rosters.dropna(subset=["gsis_id"]).copy()
        rosters["pos_detail"] = rosters["depth_chart_position"].fillna(rosters["position"])
        self.weekly = rosters
        # Most common detailed position and jersey number per player and season.
        mode = (rosters.groupby(["gsis_id", "season"])
                .agg(pos=("pos_detail", lambda s: s.mode().iat[0] if s.notna().any() else None),
                     group_pos=("position", lambda s: s.mode().iat[0] if s.notna().any() else None),
                     num=("jersey_number", "last"))
                .reset_index())
        self._season = {(r.gsis_id, int(r.season)): (r.pos, r.group_pos, r.num)
                        for r in mode.itertuples()}
        self._names_from_roster = (rosters.drop_duplicates("gsis_id", keep="last")
                                   .set_index("gsis_id")[["full_name", "first_name",
                                                          "last_name"]].to_dict("index"))

    def position(self, gsis_id: str, season: int) -> str | None:
        """Detailed position (QB, T, CB, ...) for the season, else the latest known."""
        for s in (season, season - 1, season + 1):
            entry = self._season.get((gsis_id, s))
            if entry and entry[0]:
                return entry[0]
        info = self._info.get(gsis_id)
        return info["position"] if info else None

    def group(self, gsis_id: str, season: int) -> str | None:
        pos = self.position(gsis_id, season)
        return POSITION_GROUP.get(pos) if pos else None

    def spot_position(self, gsis_id: str, season: int, fallback: str) -> str:
        return spot_position(self.position(gsis_id, season), fallback)

    def number(self, gsis_id: str, season: int) -> int | None:
        entry = self._season.get((gsis_id, season))
        number = clean_number(entry[2]) if entry else None
        if number is None and gsis_id in self._info:
            number = clean_number(self._info[gsis_id]["jersey_number"])
        return number

    def name(self, gsis_id: str) -> str:
        info = self._info.get(gsis_id)
        if info and isinstance(info["display_name"], str):
            return info["display_name"]
        roster = self._names_from_roster.get(gsis_id)
        return roster["full_name"] if roster else gsis_id

    def short(self, gsis_id: str) -> str:
        info = self._info.get(gsis_id)
        if info and isinstance(info["short_name"], str) and info["short_name"]:
            return info["short_name"]
        src = info or self._names_from_roster.get(gsis_id) or {}
        first, last = src.get("first_name"), src.get("last_name")
        if isinstance(first, str) and isinstance(last, str) and first:
            return f"{first[0]}.{last}"
        return self.name(gsis_id)

    def positions_frame(self, keys: pd.DataFrame, id_col: str) -> pd.Series:
        """Vectorised ``position`` for a frame with ``id_col`` and ``season`` columns."""
        cache: dict[tuple[str, int], str | None] = {}
        out = []
        for gsis_id, season in zip(keys[id_col], keys["season"]):
            if not isinstance(gsis_id, str):
                out.append(None)
                continue
            key = (gsis_id, int(season))
            if key not in cache:
                cache[key] = self.position(*key)
            out.append(cache[key])
        return pd.Series(out, index=keys.index, dtype=object)
