"""``special.json``: kicking tables, clock constants and decision models.

Punt and kickoff results are stored as empirical tables (one row per real kick) so the
engine can draw a real outcome. ``recv_yl`` is the receiving team's ``yardline_100`` at
its next snap, i.e. 100 minus its distance from its own goal line, which includes any
penalty enforced on the kick. Special cases, from the receiving team's point of view:

* return touchdown (flag 4): ``recv_yl = 0``;
* kicking team recovered (flag 8): ``recv_yl = 100 - kicking team's yl at its next
  snap`` (the same spot seen from the receiving side); ``100`` if the kicking team
  recovered in the end zone for a touchdown.

Kicks after which the half ended before anyone snapped are dropped.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import clock, models
from .common import int_list

SPECIAL_VERSION = 1
KICKOFF_RULE_SINCE = 2025   # touchbacks to the 35 under the current kickoff rule
ONSIDE_SINCE = 2022

P_BLOCKED, P_TOUCHBACK, P_RETURN_TD, P_KICKER_RECOVERED, P_DEAD = 1, 2, 4, 8, 16


def _flag(series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").fillna(0).to_numpy() == 1


def _kick_table(kicks: pd.DataFrame, kicking: pd.Series, receiving: pd.Series,
                dead_ball: np.ndarray, blocked: np.ndarray) -> pd.DataFrame:
    """recv_yl and fl for kicks, given the kicking and receiving team per row."""
    same_half = kicks["ns_half"].eq(kicks["game_half"]).to_numpy()
    td = _flag(kicks["touchdown"])
    return_td = td & kicks["td_team"].eq(receiving).to_numpy()
    kicker_td = td & kicks["td_team"].eq(kicking).to_numpy()
    next_receiver = same_half & kicks["ns_pos"].eq(receiving).to_numpy()
    next_kicker = same_half & kicks["ns_pos"].eq(kicking).to_numpy()
    ns_yl = kicks["ns_yl"].to_numpy(float)

    recv_yl = np.select([return_td, kicker_td, next_receiver, next_kicker],
                        [0.0, 100.0, ns_yl, 100 - ns_yl], default=np.nan)
    fl = np.zeros(len(kicks), dtype=int)
    fl |= np.where(blocked, P_BLOCKED, 0)
    fl |= np.where(_flag(kicks["touchback"]), P_TOUCHBACK, 0)
    fl |= np.where(return_td, P_RETURN_TD, 0)
    fl |= np.where(kicker_td | (next_kicker & ~return_td), P_KICKER_RECOVERED, 0)
    fl |= np.where(dead_ball, P_DEAD, 0)
    table = pd.DataFrame({"yl": kicks["yardline_100"].to_numpy(), "recv_yl": recv_yl, "fl": fl,
                          "season": kicks["season"].to_numpy()})
    return table[np.isfinite(table["recv_yl"])]


def punt_table(seq: pd.DataFrame) -> pd.DataFrame:
    punts = seq[seq["play_type"].eq("punt")]
    dead = (_flag(punts["punt_out_of_bounds"]) | _flag(punts["punt_downed"])
            | _flag(punts["punt_fair_catch"]))
    return _kick_table(punts, punts["posteam"], punts["defteam"], dead,
                       _flag(punts["punt_blocked"]))


def kickoff_table(seq: pd.DataFrame) -> pd.DataFrame:
    """Non-onside kickoffs under the current rule. nflverse ``posteam`` = receiving team."""
    kicks = seq[seq["play_type"].eq("kickoff") & seq["season"].ge(KICKOFF_RULE_SINCE)
                & ~seq["desc"].str.contains("onside", case=False, na=False)]
    return _kick_table(kicks, kicks["defteam"], kicks["posteam"],
                       _flag(kicks["kickoff_out_of_bounds"]), np.zeros(len(kicks), bool))


def onside(seq: pd.DataFrame) -> dict:
    kicks = seq[seq["play_type"].eq("kickoff") & seq["season"].ge(ONSIDE_SINCE)
                & seq["desc"].str.contains("onside", case=False, na=False)]
    recovered = _flag(kicks["own_kickoff_recovery"])
    return {"rate": round(float(recovered.mean()), 4) if len(kicks) else 0.0,
            "n": int(len(kicks))}


def pat_rates(seq: pd.DataFrame) -> tuple[dict, dict]:
    xp = seq[seq["play_type"].eq("extra_point") & seq["extra_point_result"].notna()]
    two = seq[_flag(seq["two_point_attempt"]) & seq["play_type"].isin(["run", "pass"])]
    xp_out = {"rate": round(float(xp["extra_point_result"].eq("good").mean()), 4),
              "blocked": round(float(xp["extra_point_result"].eq("blocked").mean()), 4),
              "n": int(len(xp))}
    two_out = {"rate": round(float(two["two_point_conv_result"].eq("success").mean()), 4),
               "n": int(len(two))}
    return xp_out, two_out


def build_special(seq: pd.DataFrame, lib: pd.DataFrame, games: pd.DataFrame) -> dict:
    punts = punt_table(seq)
    kickoffs = kickoff_table(seq)
    xp, two = pat_rates(seq)
    regular = lib[lib["two"] == 0]
    epa = pd.to_numeric(regular["epa"], errors="coerce") / 100
    return {
        "version": SPECIAL_VERSION,
        "fg": models.fit_fg(seq),
        "xp": xp,
        "two": two,
        "punt": {"cols": {"yl": int_list(punts["yl"]), "recv_yl": int_list(punts["recv_yl"]),
                          "fl": int_list(punts["fl"])}},
        "kickoff": {"cols": {"recv_yl": int_list(kickoffs["recv_yl"]),
                             "fl": int_list(kickoffs["fl"])},
                    "seasons": sorted(int(s) for s in kickoffs["season"].unique())},
        "onside": onside(seq),
        "between": clock.between_percentiles(lib),
        "dur": clock.fallback_durations(seq, lib),
        "fourth": models.fit_fourth(seq),
        "go2": models.fit_go2(seq),
        "halftime_wp": models.fit_halftime_wp(seq, games),
        "league": {"epa_sd_pass": round(float(epa[regular["kind"].eq("pass")].std()), 4),
                   "epa_sd_run": round(float(epa[regular["kind"].eq("run")].std()), 4)},
    }
