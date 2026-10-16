"""The play library (``plays.json``): every real called run or pass, as data for the engine.

Which rows are in the library
-----------------------------
* ``play_type`` run or pass that is not a kneel, spike or aborted snap. Two-point tries
  are included with ``two = 1``, ``down = 0`` and ``yl = ytg = 2``.
* ``play_type == 'no_play'`` snaps of a pass or run wiped out by an accepted post-snap
  penalty (flag 2048). Pre-snap fouls (false start, offside, illegal formation/shift/
  motion, too many men, delay of game, ...) and offsetting penalties are excluded: they
  do not depend on the call.
* Fake punts and fake field goals (snaps from punt or field-goal formation) are
  excluded: they are not plays an offense calls from scrimmage.

How the outcome columns are computed
------------------------------------
* ``yds``: when the same offense snaps next in the same half, ``yds`` is the change in
  ``yardline_100`` to that snap. This includes sack losses, any accepted penalty
  enforced on the play (e.g. a face mask tacked on, half-the-distance), and fumbles the
  offense recovered. Otherwise ``yards_gained`` plus the signed accepted penalty yards.
  A touchdown is exactly ``yl``; a safety is ``yl - 100``. Non-scoring plays are clipped
  to ``[yl - 99, yl - 1]``.
* ``tov`` (turnovers only): ``yl + yl_new - 100`` where ``yl_new`` is the recovering
  team's ``yardline_100`` at its next snap. On a return touchdown (flag 32) the ball
  ends in the offense's own end zone, so ``yl_new = 0`` and ``tov = yl - 100``. When the
  half ends before the defense snaps, ``yl_new`` is estimated from the catch/fumble spot
  (an interception in the end zone is a touchback at the 20).
* An interception or lost fumble only counts (flags 64/128) when possession actually
  changed: if the offense got the ball back on the same play it is an ordinary play.
* ``dur``: see ``pipeline/clock.py``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import clock
from .calls import CALL_INDEX, CLASSIFY_COLUMNS, classify, fill_locations_from_desc
from .common import (FL_AUTO_FIRST, FL_DEF_TD, FL_FIRST_DOWN, FL_FUMBLE_LOST, FL_INCOMPLETE,
                     FL_INT, FL_NO_PLAY, FL_OUT_OF_BOUNDS, FL_PENALTY, FL_SACK, FL_SAFETY,
                     FL_SCRAMBLE, FL_TD, POSITION_GROUP, game_mode, int_list,
                     is_second_half)
from .roster import PlayerDirectory

LIBRARY_VERSION = 1

PRE_SNAP_PENALTIES = {
    "False Start", "Delay of Game", "Defensive Delay of Game", "Encroachment",
    "Neutral Zone Infraction", "Defensive Offside", "Offensive Offside", "Illegal Shift",
    "Illegal Formation", "Illegal Motion", "Illegal Substitution", "Illegal Snap",
    "Defensive Too Many Men on Field", "Offensive Too Many Men on Field",
}
SPECIAL_FORMATION = r"\((?:Punt|Field Goal) formation\)"

TARGET_GROUP = {"QB": 0, "RB": 1, "WR": 2, "TE": 3}
LOCATION = {"left": 0, "middle": 1, "right": 2}

PLAY_COLUMNS = ["call", "g", "pid", "down", "ytg", "yl", "mode", "hs", "margin", "yds", "dur",
                "fl", "tov", "epa", "look", "air", "loc", "tgt", "two"]


def _flag(series) -> np.ndarray:
    """nflverse 0/1 (possibly NA) column -> bool array."""
    return pd.to_numeric(series, errors="coerce").fillna(0).to_numpy() == 1


def annotate(pbp: pd.DataFrame) -> pd.DataFrame:
    """Add sequence context used throughout the pipeline.

    * ``is_snap``: the row is a snap or kick (not a timeout or administrative row).
    * ``nr_*``: the immediately following row of any kind (timeouts included).
    * ``ns_*``: the next snap in the same game.
    """
    df = pbp.copy()
    df["second_half"] = is_second_half(df["game_half"])
    df["is_timeout"] = _flag(df["timeout"])
    df["is_snap"] = df["posteam"].notna() & df["play_type"].notna() & ~df["is_timeout"]
    df["mode"] = game_mode(df["second_half"], df["half_seconds_remaining"],
                           df["score_differential"].fillna(0))

    by_game = df.groupby("game_id", sort=False)
    df["nr_gsr"] = by_game["game_seconds_remaining"].shift(-1)
    df["nr_qsr"] = by_game["quarter_seconds_remaining"].shift(-1)
    df["nr_qtr"] = by_game["qtr"].shift(-1)
    df["nr_timeout_team"] = by_game["timeout_team"].shift(-1).where(
        by_game["is_timeout"].shift(-1, fill_value=False))
    df["nr_is_snap"] = by_game["is_snap"].shift(-1, fill_value=False)

    snap_cols = ["posteam", "yardline_100", "game_half", "play_type",
                 "game_seconds_remaining", "qtr", "mode", "no_huddle"]
    snaps = df.loc[df["is_snap"], ["game_id", *snap_cols]]
    nxt = snaps.groupby("game_id", sort=False)[snap_cols].shift(-1)
    nxt.columns = ["ns_pos", "ns_yl", "ns_half", "ns_type", "ns_gsr", "ns_qtr", "ns_mode",
                   "ns_no_huddle"]
    return df.join(nxt)


def library_mask(df: pd.DataFrame) -> pd.Series:
    """Rows that belong in the play library (see module docstring)."""
    called = (df["play_type"].isin(["run", "pass"]) & ~_flag(df["qb_kneel"])
              & ~_flag(df["qb_spike"]) & ~_flag(df["aborted_play"]))
    wiped = (df["play_type"].eq("no_play") & df["posteam"].notna()
             & (_flag(df["pass"]) | _flag(df["rush"])) & _flag(df["penalty"])
             & df["penalty_team"].notna() & ~df["penalty_type"].isin(PRE_SNAP_PENALTIES)
             & df["down"].notna())  # two-point tries wiped out by a penalty have no down
    fake_kick = df["desc"].str.contains(SPECIAL_FORMATION, na=False)
    return (called | wiped) & ~fake_kick & df["posteam"].notna()


def _ftn_flags(ftn: pd.DataFrame) -> pd.DataFrame:
    cols = {"is_trick_play": "trick", "is_rpo": "rpo", "is_screen_pass": "screen",
            "is_play_action": "play_action", "is_qb_out_of_pocket": "out_of_pocket",
            "is_qb_sneak": "sneak", "n_defense_box": "ftn_box", "n_blitzers": "ftn_blitzers",
            "n_pass_rushers": "ftn_rushers"}
    return ftn[["game_id", "play_id", *cols]].rename(columns=cols)


def defensive_look(part_box, part_rushers, ftn_box, ftn_blitzers, ftn_rushers) -> np.ndarray:
    """Look code (docs/DATA.md): 1 blitz, 2 loaded box, 3 light box, 0 base/unknown.

    Participation counts win when present (> 0); FTN counts fill the gaps. Participation
    does not count pass rushers on runs, so FTN blitzers decide blitzes there.
    """
    def num(x):
        return pd.to_numeric(pd.Series(x), errors="coerce").to_numpy(float)

    part_box, part_rushers = num(part_box), num(part_rushers)
    ftn_box, ftn_blitzers, ftn_rushers = num(ftn_box), num(ftn_blitzers), num(ftn_rushers)
    box = np.where(part_box > 0, part_box, ftn_box)
    rushers = np.where(part_rushers > 0, part_rushers, ftn_rushers)
    blitz = (rushers >= 5) | (ftn_blitzers >= 1)
    loaded = box >= 8
    light = (box > 0) & (box <= 6)
    return np.select([blitz, loaded, light], [1, 2, 3], default=0)


def _signed_penalty(df: pd.DataFrame) -> np.ndarray:
    """Accepted penalty yards from the offense's point of view (+ = toward the end zone)."""
    yards = pd.to_numeric(df["penalty_yards"], errors="coerce").fillna(0).to_numpy()
    against_defense = df["penalty_team"].eq(df["defteam"]).to_numpy()
    against_offense = df["penalty_team"].eq(df["posteam"]).to_numpy()
    return np.where(against_defense, yards, np.where(against_offense, -yards, 0.0))


def build_library(seq: pd.DataFrame, ftn: pd.DataFrame, participation: pd.DataFrame,
                  directory: PlayerDirectory) -> pd.DataFrame:
    """Return one row per library play with the ``PLAY_COLUMNS`` plus context columns."""
    lib = seq[library_mask(seq)].copy()
    lib = lib.merge(_ftn_flags(ftn), on=["game_id", "play_id"], how="left")
    if not participation.empty:
        part = participation[["game_id", "play_id", "defenders_in_box",
                              "number_of_pass_rushers"]]
        lib = lib.merge(part, on=["game_id", "play_id"], how="left")
    else:
        lib["defenders_in_box"] = np.nan
        lib["number_of_pass_rushers"] = np.nan
    for col in ("trick", "rpo", "screen", "play_action", "out_of_pocket", "sneak"):
        lib[col] = lib[col].eq(True)  # uncharted plays (NA) count as False

    no_play = lib["play_type"].eq("no_play").to_numpy()
    two = _flag(lib["two_point_attempt"])
    lib = fill_locations_from_desc(lib)

    # --- call -----------------------------------------------------------------------
    lib["is_pass"] = _flag(lib["pass"])
    lib["is_run"] = _flag(lib["rush"]) & ~lib["is_pass"]
    lib["scramble"] = _flag(lib["qb_scramble"])
    lib["hs"] = lib["half_seconds_remaining"]
    lib["passer"] = lib["passer_id"].fillna(lib["passer_player_id"])
    lib["rusher"] = lib["rusher_id"].fillna(lib["rusher_player_id"])
    lib["receiver"] = lib["receiver_id"].fillna(lib["receiver_player_id"])
    lib["passer_pos"] = directory.positions_frame(lib, "passer")
    lib["rusher_pos"] = directory.positions_frame(lib, "rusher")
    lib["receiver_pos"] = directory.positions_frame(lib, "receiver")
    call_ids = classify(lib[CLASSIFY_COLUMNS])
    lib["call_id"] = call_ids
    lib["call"] = [CALL_INDEX[c] for c in call_ids]

    # --- situation ------------------------------------------------------------------
    yl = lib["yardline_100"].to_numpy(float)
    lib["down"] = np.where(two, 0, lib["down"].fillna(0))
    lib["ytg"] = np.where(two, 2, lib["ydstogo"])
    lib["yl"] = np.where(two, 2, yl)
    lib["margin"] = lib["score_differential"].fillna(0)  # "mode" comes from annotate()

    # --- result flags -----------------------------------------------------------------
    same_half_next = lib["ns_half"].eq(lib["game_half"]).to_numpy()
    next_same_team = same_half_next & lib["ns_pos"].eq(lib["posteam"]).to_numpy()
    next_other_team = same_half_next & lib["ns_pos"].eq(lib["defteam"]).to_numpy()
    td = _flag(lib["touchdown"])
    off_td = td & lib["td_team"].eq(lib["posteam"]).to_numpy() & ~no_play
    def_td = td & lib["td_team"].eq(lib["defteam"]).to_numpy() & ~no_play
    two_good = two & lib["two_point_conv_result"].eq("success").to_numpy()
    possession_lost = def_td | next_other_team
    interception = _flag(lib["interception"]) & possession_lost & ~no_play
    fumble_lost = _flag(lib["fumble_lost"]) & possession_lost & ~interception & ~no_play
    turnover = interception | fumble_lost
    safety = _flag(lib["safety"]) & ~no_play & ~two
    penalty_yards = _signed_penalty(lib)
    accepted_penalty = (_flag(lib["penalty"]) & lib["penalty_team"].notna().to_numpy()
                        & (pd.to_numeric(lib["penalty_yards"], errors="coerce")
                           .fillna(0).to_numpy() > 0))

    fl = np.zeros(len(lib), dtype=np.int64)
    fl |= np.where(accepted_penalty, FL_PENALTY, 0)
    fl |= np.where(_flag(lib["first_down_penalty"]), FL_AUTO_FIRST, 0)
    fl |= np.where(_flag(lib["incomplete_pass"]) & ~no_play & ~interception, FL_INCOMPLETE, 0)
    fl |= np.where(_flag(lib["out_of_bounds"]) & ~no_play, FL_OUT_OF_BOUNDS, 0)
    fl |= np.where(off_td | two_good, FL_TD, 0)
    fl |= np.where(def_td, FL_DEF_TD, 0)
    fl |= np.where(interception, FL_INT, 0)
    fl |= np.where(fumble_lost, FL_FUMBLE_LOST, 0)
    fl |= np.where(safety, FL_SAFETY, 0)
    fl |= np.where(_flag(lib["sack"]) & ~no_play, FL_SACK, 0)
    fl |= np.where(lib["scramble"] & ~no_play, FL_SCRAMBLE, 0)
    fl |= np.where(no_play, FL_NO_PLAY, 0)
    fl |= np.where(_flag(lib["first_down"]) & ~two, FL_FIRST_DOWN, 0)
    lib["fl"] = fl

    # --- yards ------------------------------------------------------------------------
    gained = pd.to_numeric(lib["yards_gained"], errors="coerce").fillna(0).to_numpy()
    measured = yl - lib["ns_yl"].to_numpy(float)
    by_next_snap = next_same_team & ~turnover & ~def_td & ~off_td & np.isfinite(measured)
    yds = np.where(by_next_snap, measured, gained + np.where(accepted_penalty, penalty_yards, 0))
    yds = np.clip(yds, yl - 99, yl - 1)
    yds = np.where(off_td, yl, yds)
    yds = np.where(safety, yl - 100, yds)
    yds = np.where(turnover, np.clip(gained, yl - 99, yl - 1), yds)
    yds = np.where(two, np.where(two_good, 2, 0), yds)
    lib["yds"] = yds

    # --- turnovers --------------------------------------------------------------------
    air = pd.to_numeric(lib["air_yards"], errors="coerce").fillna(0).to_numpy()
    catch_spot = np.where(interception, yl - air, yl - gained)  # offense's yardline_100
    estimated_new = np.where(catch_spot <= 0, 80, np.clip(100 - catch_spot, 1, 99))
    yl_new = np.where(next_other_team, lib["ns_yl"].to_numpy(float), estimated_new)
    tov = np.where(def_td, yl - 100, yl + yl_new - 100)
    lib["tov"] = np.where(turnover & ~two, tov, 0)

    # --- descriptors ------------------------------------------------------------------
    lib["epa"] = np.rint(pd.to_numeric(lib["epa"], errors="coerce").fillna(0) * 100)
    lib["look"] = defensive_look(lib["defenders_in_box"], lib["number_of_pass_rushers"],
                                 lib["ftn_box"], lib["ftn_blitzers"], lib["ftn_rushers"])
    threw = lib["is_pass"].to_numpy() & ~_flag(lib["sack"]) & ~lib["scramble"].to_numpy()
    lib["air"] = np.where(threw & ~no_play, air, 0)
    location = lib["pass_location"].where(lib["is_pass"], lib["run_location"])
    lib["loc"] = location.map(LOCATION).fillna(1).astype(int)
    carrier_pos = np.where(lib["is_run"], lib["rusher_pos"],
                           np.where(threw, lib["receiver_pos"], "QB"))
    lib["tgt"] = [TARGET_GROUP.get(POSITION_GROUP.get(p, ""), 4) if isinstance(p, str) else 4
                  for p in carrier_pos]
    lib["two"] = two.astype(int)
    lib["kind"] = np.where(lib["is_pass"], "pass", "run")

    lib["dur_measured"] = clock.measured_duration(lib)
    model = clock.DurationModel.fit(lib)
    lib["dur_s"] = np.where(np.isfinite(lib["dur_measured"]), lib["dur_measured"],
                            model.estimate(lib))
    lib["dur"] = np.rint(lib["dur_s"] * 10)
    return lib.reset_index(drop=True)


def plays_json(lib: pd.DataFrame) -> dict:
    games = sorted(lib["game_id"].unique())
    game_index = {g: i for i, g in enumerate(games)}
    cols = {"g": [game_index[g] for g in lib["game_id"]], "pid": int_list(lib["play_id"])}
    for col in PLAY_COLUMNS:
        if col not in cols:
            cols[col] = int_list(lib[col])
    return {"version": LIBRARY_VERSION, "n": len(lib), "games": games,
            "cols": {c: cols[c] for c in PLAY_COLUMNS}}
