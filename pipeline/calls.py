"""The play-call menu and the classifier that assigns every real snap to one call.

This module is the single source of truth for ``calls.json``: the order of ``CALLS`` is
the integer call index used in ``plays.json``. The classifier rules follow the table in
docs/DATA.md; they are applied in the order of ``RULE_ORDER`` (first match wins), which
is independent of the menu order.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

CALLS_VERSION = 1


def _call(id_, label, family, kind, dir_, say, depth=None):
    call = {"id": id_, "label": label, "family": family, "kind": kind, "dir": dir_, "say": say}
    if depth:
        call["depth"] = depth
    return call


# Menu order (defines the call index).
CALLS = [
    _call("run_out_l", "Outside run left", "run", "run", "left", "runs outside to the left"),
    _call("run_tackle_l", "Off tackle left", "run", "run", "left", "runs off left tackle"),
    _call("run_guard_l", "Inside run left", "run", "run", "left", "runs inside behind the left guard"),
    _call("run_middle", "Up the middle", "run", "run", "middle", "runs up the middle"),
    _call("run_guard_r", "Inside run right", "run", "run", "right", "runs inside behind the right guard"),
    _call("run_tackle_r", "Off tackle right", "run", "run", "right", "runs off right tackle"),
    _call("run_out_r", "Outside run right", "run", "run", "right", "runs outside to the right"),
    _call("qb_run", "QB run", "run", "run", None, "keeps it on a designed QB run"),
    _call("qb_sneak", "QB sneak", "run", "run", "middle", "sneaks it"),
    _call("short_l", "Short pass left", "pass", "pass", "left", "throws short to the left", "short"),
    _call("short_m", "Short pass middle", "pass", "pass", "middle", "throws short over the middle", "short"),
    _call("short_r", "Short pass right", "pass", "pass", "right", "throws short to the right", "short"),
    _call("deep_l", "Deep pass left", "pass", "pass", "left", "goes deep down the left side", "deep"),
    _call("deep_m", "Deep pass middle", "pass", "pass", "middle", "goes deep down the middle", "deep"),
    _call("deep_r", "Deep pass right", "pass", "pass", "right", "goes deep down the right side", "deep"),
    _call("screen", "Screen pass", "pass", "pass", None, "throws a screen", "screen"),
    _call("pa_short", "Play-action short", "pass", "pass", None, "fakes the handoff and throws short", "short"),
    _call("pa_deep", "Play-action deep", "pass", "pass", None, "fakes the handoff and goes deep", "deep"),
    _call("rollout", "QB rollout", "pass", "pass", None, "rolls out and throws", "short"),
    _call("hail_mary", "Hail Mary", "pass", "pass", None, "heaves a Hail Mary", "hail"),
    _call("rpo_run", "RPO keep/give", "rpo", "run", None, "reads the defense and hands it off"),
    _call("rpo_pass", "RPO throw", "rpo", "pass", None, "reads the defense and throws", "short"),
    _call("end_around", "End-around", "trick", "run", None, "hands it to a receiver on an end-around"),
    _call("direct_snap", "Direct snap", "trick", "run", None, "snaps it directly to a runner"),
    _call("receiver_pass", "Trick pass", "trick", "pass", None, "lets a non-quarterback throw it", "deep"),
    _call("flea_flicker", "Flea flicker", "trick", "pass", None, "runs the flea flicker", "deep"),
]
CALL_INDEX = {c["id"]: i for i, c in enumerate(CALLS)}
CALL_KIND = np.array([c["kind"] for c in CALLS])

# Classification order (first match wins), as listed in docs/DATA.md.
RULE_ORDER = [
    "flea_flicker", "receiver_pass", "end_around", "direct_snap", "hail_mary", "rpo_pass",
    "rpo_run", "screen", "pa_deep", "pa_short", "rollout", "deep_l", "deep_m", "deep_r",
    "short_l", "short_m", "short_r", "qb_sneak", "qb_run", "run_out_l", "run_out_r",
    "run_tackle_l", "run_tackle_r", "run_guard_l", "run_guard_r", "run_middle",
]

# Columns ``classify`` expects (booleans must not contain NA):
#   is_pass, is_run   dropback (attempt, sack or scramble) / designed run
#   scramble          QB scramble (is_pass is also true)
#   desc              nflverse play description
#   passer_pos, rusher_pos   roster positions of the passer / runner (None if unknown)
#   air_yards, hs     air yards (NaN if none), seconds left in the half
#   pass_length, pass_location, run_location, run_gap   nflverse location fields
#   trick, rpo, screen, play_action, out_of_pocket, sneak   FTN flags (False if uncharted)
CLASSIFY_COLUMNS = ["is_pass", "is_run", "scramble", "desc", "passer_pos", "rusher_pos",
                    "air_yards", "hs", "pass_length", "pass_location", "run_location",
                    "run_gap", "trick", "rpo", "screen", "play_action", "out_of_pocket",
                    "sneak"]

# A pitch, lateral or direct snap to someone else before the quarterback's throw.
_FLEA_RE = re.compile(r"flea[ -]?flicker|direct snap to|lateral|pitch|backward", re.I)


def classify(df: pd.DataFrame) -> np.ndarray:
    """Return the call id (str) for every row of ``df`` (see CLASSIFY_COLUMNS)."""
    is_pass = df["is_pass"].to_numpy(bool)
    is_run = df["is_run"].to_numpy(bool)
    desc = df["desc"].fillna("").astype(str)
    air = df["air_yards"].astype(float).to_numpy()
    passer_qb = df["passer_pos"].eq("QB").to_numpy()
    passer_known = df["passer_pos"].notna().to_numpy()
    rusher_pos = df["rusher_pos"]
    trick = df["trick"].to_numpy(bool)
    loc_pass = df["pass_location"]
    loc_run = df["run_location"]
    gap = df["run_gap"]
    deep = df["pass_length"].eq("deep").to_numpy()

    # The ball goes backward to the quarterback before his throw: a pitch, lateral or
    # direct snap to someone else in the text before the word "pass".
    pre_throw = desc.str.split(" pass ", n=1).str[0]
    flea_text = (desc.str.contains("flea", case=False)
                 | (pre_throw.str.contains(_FLEA_RE) & df["passer_pos"].eq("QB")))

    def side(loc: pd.Series, value: str) -> np.ndarray:
        return loc.eq(value).to_numpy()

    rules = {
        "flea_flicker": trick & is_pass & flea_text.to_numpy(),
        "receiver_pass": is_pass & passer_known & ~passer_qb & ~df["scramble"].to_numpy(bool),
        "end_around": is_run & rusher_pos.eq("WR").to_numpy(),
        "direct_snap": trick & is_run,
        "hail_mary": is_pass & (((air >= 40) & (df["hs"].to_numpy(float) <= 30))
                                | desc.str.contains("hail mary", case=False).to_numpy()),
        "rpo_pass": df["rpo"].to_numpy(bool) & is_pass,
        "rpo_run": df["rpo"].to_numpy(bool) & is_run,
        "screen": df["screen"].to_numpy(bool) & is_pass,
        "pa_deep": df["play_action"].to_numpy(bool) & is_pass & (air >= 15),
        "pa_short": df["play_action"].to_numpy(bool) & is_pass,
        "rollout": df["out_of_pocket"].to_numpy(bool) & is_pass & ~df["scramble"].to_numpy(bool),
        "deep_l": is_pass & deep & side(loc_pass, "left"),
        "deep_m": is_pass & deep & ~side(loc_pass, "left") & ~side(loc_pass, "right"),
        "deep_r": is_pass & deep & side(loc_pass, "right"),
        "short_l": is_pass & side(loc_pass, "left"),
        "short_m": is_pass & ~side(loc_pass, "left") & ~side(loc_pass, "right"),
        "short_r": is_pass & side(loc_pass, "right"),
        "qb_sneak": df["sneak"].to_numpy(bool) & is_run,
        "qb_run": is_run & rusher_pos.eq("QB").to_numpy(),
        "run_out_l": is_run & gap.eq("end").to_numpy() & side(loc_run, "left"),
        "run_out_r": is_run & gap.eq("end").to_numpy() & side(loc_run, "right"),
        "run_tackle_l": is_run & gap.eq("tackle").to_numpy() & side(loc_run, "left"),
        "run_tackle_r": is_run & gap.eq("tackle").to_numpy() & side(loc_run, "right"),
        "run_guard_l": is_run & gap.eq("guard").to_numpy() & side(loc_run, "left"),
        "run_guard_r": is_run & gap.eq("guard").to_numpy() & side(loc_run, "right"),
        "run_middle": is_run,
    }
    conditions = [rules[name] for name in RULE_ORDER]
    return np.select(conditions, RULE_ORDER, default="")


# Location phrases in nflverse descriptions, used where the structured fields are empty
# (penalty "No Play" rows).
_PASS_LOC_RE = re.compile(r"pass (?:incomplete )?(short|deep) (left|middle|right)")
_RUN_LOC_RE = re.compile(r"\b(left|right) (end|tackle|guard)\b")


def fill_locations_from_desc(df: pd.DataFrame) -> pd.DataFrame:
    """Fill missing pass_length/pass_location/run_location/run_gap from the description."""
    df = df.copy()
    desc = df["desc"].fillna("")
    passes = desc.str.extract(_PASS_LOC_RE)
    runs = desc.str.extract(_RUN_LOC_RE)
    run_side = np.where(runs[0].notna(), runs[0],
                        np.where(desc.str.contains("up the middle"), "middle", None))

    def fill(col: str, fallback) -> None:
        df[col] = np.where(df[col].notna(), df[col].astype(object), fallback)

    fill("pass_length", passes[0])
    fill("pass_location", passes[1])
    fill("run_location", run_side)
    fill("run_gap", runs[1])
    return df


def calls_json() -> dict:
    return {"version": CALLS_VERSION, "calls": CALLS}
