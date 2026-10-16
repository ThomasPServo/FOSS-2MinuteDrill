"""Play durations and the clock runoff between snaps.

nflverse ``play_clock`` is always 0 in these seasons, so neither quantity is available
directly. Each pbp row carries the game clock at its start, which gives:

* **Measured durations.** When the clock stops right after a play, the next row (the
  next snap, or a timeout) starts at the time the play ended, so
  ``dur = game_seconds_remaining(play) - game_seconds_remaining(next row)``. The clock
  stops after incompletions, scores, turnovers, out-of-bounds inside the final 2:00 of
  the first half (or overtime) and the final 5:00 of the game, and when a timeout follows
  immediately. Only timeouts called by the side that wants the clock stopped (the
  hurrying offense, or the defense against a clock-killing offense / at the end of the
  first half) are used: other timeouts are often called after the clock has run.
  Rows followed by the end of a quarter are not used (the clock simply ran out), nor are
  timeout-based measurements spanning the two-minute warning (nflverse has no row for
  it). Measurements are clipped to 2-15 s.
* **Estimated durations** for every other play: the median measured duration for the
  same outcome (run, scramble, sack, incompletion, interception, completion) and gain
  bucket, falling back to the outcome median and then the overall median.
* **Between-snap runoff** (``special.between``): for consecutive snaps by the same
  offense with the clock running (previous play in bounds, no stoppage, no timeout row,
  not across the two-minute warning), ``between = elapsed - estimated duration of the
  previous play``, grouped by the tempo of the second snap.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .common import (FL_DEF_TD, FL_FUMBLE_LOST, FL_INCOMPLETE, FL_INT, FL_NO_PLAY,
                     FL_OUT_OF_BOUNDS, FL_PENALTY, FL_SAFETY, FL_TD, MODE_HURRY, MODE_KILL)

DUR_MIN, DUR_MAX = 2.0, 15.0
MIN_ELAPSED = 1.5            # shorter "measurements" are clock-operator artefacts
GAIN_EDGES = [0, 5, 10, 20, 40]
MIN_GROUP = 15               # minimum measured plays for a (outcome, gain) median
BETWEEN_MIN, BETWEEN_MAX = 3.0, 40.0
PERCENTILES = list(range(5, 100, 5))


def _flag(series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").fillna(0).to_numpy() == 1


def stop_window(df: pd.DataFrame) -> np.ndarray:
    """True where an out-of-bounds play stops the clock until the next snap."""
    qtr = df["qtr"].to_numpy()
    hs = df["half_seconds_remaining"].to_numpy(float)
    gsr = df["game_seconds_remaining"].to_numpy(float)
    return (((qtr == 2) | (qtr >= 5)) & (hs <= 120)) | ((qtr == 4) & (gsr <= 300))


def measured_duration(df: pd.DataFrame) -> np.ndarray:
    """Seconds from snap to whistle where the clock stopped right after the play, else NaN.

    Expects the library frame (``fl`` flags, ``mode``) with the ``annotate`` columns.
    """
    fl = df["fl"].to_numpy()
    elapsed = (df["game_seconds_remaining"] - df["nr_gsr"]).to_numpy(float)
    hs = df["half_seconds_remaining"].to_numpy(float)
    mode = df["mode"].to_numpy()
    second_half = df["second_half"].to_numpy(bool)

    stops = (((fl & (FL_INCOMPLETE | FL_TD | FL_DEF_TD | FL_INT | FL_FUMBLE_LOST
                     | FL_SAFETY)) > 0)
             | (((fl & FL_OUT_OF_BOUNDS) > 0) & stop_window(df)))
    to_team = df["nr_timeout_team"]
    timeout_stop = ((to_team.eq(df["posteam"]).to_numpy() & (mode == MODE_HURRY))
                    | (to_team.eq(df["defteam"]).to_numpy()
                       & ((mode == MODE_KILL) | (~second_half & (hs <= 120)))))
    qtr = df["qtr"].to_numpy()
    crosses_warning = np.isin(qtr, [2, 4]) & (hs > 120) & (hs - elapsed < 120)
    timeout_stop &= ~crosses_warning

    valid = ((df["nr_qtr"].to_numpy() == qtr) & (df["nr_qsr"].to_numpy(float) > 0)
             & (elapsed >= MIN_ELAPSED) & ((fl & FL_NO_PLAY) == 0)
             & (df["two"].to_numpy() == 0))
    return np.where(valid & (stops | timeout_stop), np.clip(elapsed, DUR_MIN, DUR_MAX), np.nan)


def outcome(df: pd.DataFrame) -> np.ndarray:
    """Outcome class used to group durations."""
    desc = df["desc"].fillna("")
    no_play = df["play_type"].eq("no_play").to_numpy()
    incomplete = _flag(df["incomplete_pass"]) | (no_play & desc.str.contains("incomplete").to_numpy())
    sack = _flag(df["sack"]) | (no_play & desc.str.contains("sacked").to_numpy())
    return np.select(
        [df["scramble"].to_numpy(bool), sack, _flag(df["interception"]), incomplete,
         df["is_run"].to_numpy(bool)],
        ["scramble", "sack", "interception", "incomplete", "run"], default="complete")


def gain_bucket(df: pd.DataFrame) -> np.ndarray:
    gained = pd.to_numeric(df["yards_gained"], errors="coerce").fillna(0).to_numpy()
    return np.digitize(gained, GAIN_EDGES)


class DurationModel:
    """Median measured duration by (outcome, gain bucket) with fallbacks."""

    def __init__(self, by_group: dict, by_outcome: dict, overall: float):
        self.by_group = by_group
        self.by_outcome = by_outcome
        self.overall = overall

    @classmethod
    def fit(cls, df: pd.DataFrame) -> "DurationModel":
        measured = df["dur_measured"].to_numpy(float)
        ok = np.isfinite(measured)
        frame = pd.DataFrame({"outcome": outcome(df)[ok], "bucket": gain_bucket(df)[ok],
                              "dur": measured[ok]})
        grouped = frame.groupby(["outcome", "bucket"])["dur"].agg(["median", "size"])
        by_group = grouped.loc[grouped["size"] >= MIN_GROUP, "median"].to_dict()
        by_outcome = frame.groupby("outcome")["dur"].median().to_dict()
        return cls(by_group, by_outcome, float(frame["dur"].median()))

    def estimate(self, df: pd.DataFrame) -> np.ndarray:
        result = []
        for out, bucket in zip(outcome(df), gain_bucket(df)):
            value = self.by_group.get((out, bucket))
            if value is None:
                value = self.by_outcome.get(out, self.overall)
            result.append(value)
        return np.asarray(result, dtype=float)


def between_percentiles(lib: pd.DataFrame) -> dict[str, list[float]]:
    """``special.between``: 19 percentiles of runoff between snaps, by tempo."""
    stopped = (FL_INCOMPLETE | FL_OUT_OF_BOUNDS | FL_TD | FL_DEF_TD | FL_INT
               | FL_FUMBLE_LOST | FL_SAFETY | FL_PENALTY | FL_NO_PLAY)
    hs = lib["half_seconds_remaining"].to_numpy(float)
    elapsed = (lib["game_seconds_remaining"] - lib["ns_gsr"]).to_numpy(float)
    crosses_warning = lib["qtr"].isin([2, 4]).to_numpy() & (hs > 120) & (hs - elapsed <= 120)
    pairs = (lib["nr_is_snap"].to_numpy(bool)
             & lib["ns_pos"].eq(lib["posteam"]).to_numpy()
             & (lib["ns_qtr"].to_numpy() == lib["qtr"].to_numpy())
             & lib["ns_type"].isin(["run", "pass", "qb_kneel", "qb_spike", "punt",
                                    "field_goal"]).to_numpy()
             & ((lib["fl"].to_numpy() & stopped) == 0)
             & (lib["two"].to_numpy() == 0)
             & ~crosses_warning)
    between = elapsed - lib["dur_s"].to_numpy(float)
    ns_mode = lib["ns_mode"].to_numpy()
    tempo = np.where(_flag(lib["ns_no_huddle"]) | (ns_mode == MODE_HURRY), "hurry",
                     np.where(ns_mode == MODE_KILL, "kill", "normal"))
    out = {}
    for name in ("hurry", "normal", "kill"):
        values = between[pairs & (tempo == name)]
        values = values[np.isfinite(values)]
        pct = np.percentile(values, PERCENTILES)
        out[name] = [round(float(v), 1) for v in np.clip(pct, BETWEEN_MIN, BETWEEN_MAX)]
    return out


def fallback_durations(seq: pd.DataFrame, lib: pd.DataFrame) -> dict[str, float]:
    """``special.dur``: median durations (s) for plays the engine times without a draw."""
    measured = lib["dur_measured"].to_numpy(float)
    ok = np.isfinite(measured)
    out_class = outcome(lib)

    def med(mask, default):
        values = measured[mask & ok]
        return round(float(np.median(values)), 1) if len(values) >= 20 else default

    # Kneels and spikes are not in the library; time them from the raw rows.
    elapsed = (seq["game_seconds_remaining"] - seq["nr_gsr"]).to_numpy(float)
    same_qtr = (seq["nr_qtr"].to_numpy() == seq["qtr"].to_numpy()) & (seq["nr_qsr"].to_numpy(float) > 0)
    kneel_to = _flag(seq["qb_kneel"]) & seq["nr_timeout_team"].eq(seq["defteam"]).to_numpy()
    spike = _flag(seq["qb_spike"])

    def raw_med(mask, default):
        values = elapsed[mask & same_qtr & (elapsed >= MIN_ELAPSED)]
        values = np.clip(values, DUR_MIN, DUR_MAX)
        return round(float(np.median(values)), 1) if len(values) >= 20 else default

    return {
        "run": med(out_class == "run", 4.5),
        "pass": med(out_class == "complete", 6.0),
        "sack": med(out_class == "sack", 5.5),
        "incomplete": med(out_class == "incomplete", 4.5),
        "kneel": raw_med(kneel_to, 2.0),
        "spike": raw_med(spike, 2.0),
    }
