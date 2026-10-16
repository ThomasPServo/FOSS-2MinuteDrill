"""yds / tov / flag conventions of the play library, on a hand-made game sequence."""

import numpy as np
import pandas as pd
import pytest

from pipeline import library
from pipeline.common import (FL_AUTO_FIRST, FL_DEF_TD, FL_FIRST_DOWN, FL_FUMBLE_LOST, FL_INT,
                             FL_NO_PLAY, FL_PENALTY, FL_SACK, FL_SAFETY, FL_TD)
from pipeline.load import PBP_COLUMNS
from pipeline.roster import PlayerDirectory

FLAGS = ["pass", "rush", "qb_kneel", "qb_spike", "qb_scramble", "aborted_play", "complete_pass",
         "incomplete_pass", "sack", "interception", "fumble_lost", "safety", "touchdown",
         "return_touchdown", "out_of_bounds", "first_down", "first_down_penalty", "penalty",
         "timeout", "two_point_attempt", "no_huddle"]


def make_game(rows: list[dict]) -> pd.DataFrame:
    """A one-game pbp frame; each row gets 6 seconds less on the clock than the previous."""
    out = []
    for i, fields in enumerate(rows):
        gsr = 3000 - 6 * i
        row = dict.fromkeys(PBP_COLUMNS, np.nan)
        row.update(dict.fromkeys(FLAGS, 0.0))
        row.update({
            "game_id": "2024_01_AWAY_HOME", "play_id": 100 + 10 * i, "order_sequence": i,
            "season": 2024, "season_type": "REG", "week": 1, "game_date": "2024-09-08",
            "home_team": "HOME", "away_team": "AWAY", "posteam": "HOME", "defteam": "AWAY",
            "qtr": 1, "game_half": "Half1", "game_seconds_remaining": gsr,
            "half_seconds_remaining": gsr - 1800, "quarter_seconds_remaining": gsr - 2700,
            "down": 1, "ydstogo": 10, "score_differential": 0, "epa": 0.25, "desc": "play",
            "play_type": "run", "yards_gained": 0.0,
        })
        row.update(fields)
        out.append(row)
    return pd.DataFrame(out)


def run(yl, **kw):
    return {"play_type": "run", "rush": 1.0, "yardline_100": yl, "rusher_id": "RB1", **kw}


def throw(yl, **kw):
    return {"play_type": "pass", "pass": 1.0, "yardline_100": yl, "passer_id": "QB1",
            "pass_length": "short", "pass_location": "left", "air_yards": 8.0, **kw}


def away(row):
    return {**row, "posteam": "AWAY", "defteam": "HOME", "passer_id": "QB2"}


@pytest.fixture(scope="module")
def lib():
    rows = [
        # 0: 5-yard run plus a 15-yard face mask on the defense -> next snap at 55
        run(75, yards_gained=5.0, penalty=1.0, penalty_team="AWAY", penalty_yards=15.0,
            penalty_type="Face Mask", first_down=1.0, first_down_penalty=1.0),
        # 1: interception thrown from the 55, AWAY takes over at its own 30 (yl 70)
        throw(55, interception=1.0, air_yards=20.0, incomplete_pass=1.0),
        # 2: AWAY 70-yard touchdown pass
        away(throw(70, complete_pass=1.0, yards_gained=70.0, touchdown=1.0, td_team="AWAY",
                   first_down=1.0)),
        away({"play_type": "extra_point", "yardline_100": 15}),
        {"play_type": "kickoff", "yardline_100": 35},
        # 5: pick-six from the HOME 25 (yl 75)
        throw(75, interception=1.0, touchdown=1.0, return_touchdown=1.0, td_team="AWAY"),
        away({"play_type": "extra_point", "yardline_100": 15}),
        {"play_type": "kickoff", "yardline_100": 35},
        # 8: fumble recovered by the offense, net 2 yards (next snap at 78)
        run(80, yards_gained=4.0),
        # 9: wiped-out pass, defensive pass interference for 20 yards, automatic first down
        throw(78, play_type="no_play", penalty=1.0, penalty_team="AWAY", penalty_yards=20.0,
              penalty_type="Defensive Pass Interference", first_down_penalty=1.0,
              first_down=1.0, pass_length=None, pass_location=None,
              desc="(9:00) 1-Q.B pass incomplete deep right to 2-W.R. PENALTY ... - No Play."),
        # 10: false start (pre-snap): not in the library
        run(58, play_type="no_play", penalty=1.0, penalty_team="HOME", penalty_yards=5.0,
            penalty_type="False Start", rush=1.0),
        # 11: sacked in the end zone for a safety
        throw(97, sack=1.0, safety=1.0, yards_gained=-3.0, air_yards=np.nan),
        # 12: successful two-point try
        throw(2, down=np.nan, ydstogo=0, two_point_attempt=1.0, two_point_conv_result="success"),
        {"play_type": "kickoff", "yardline_100": 35},
    ]
    pbp = make_game(rows)
    seq = library.annotate(pbp)
    players = pd.DataFrame({"gsis_id": ["QB1", "QB2", "RB1"],
                            "display_name": ["Q One", "Q Two", "R One"],
                            "short_name": ["Q.One", "Q.Two", "R.One"],
                            "first_name": ["Q", "Q", "R"], "last_name": ["One", "Two", "One"],
                            "position": ["QB", "QB", "RB"], "jersey_number": ["1", "2", "3"],
                            "pfr_id": [None, None, None]})
    rosters = pd.DataFrame(columns=["gsis_id", "season", "week", "team", "depth_chart_position",
                                    "position", "jersey_number", "pfr_id", "full_name",
                                    "first_name", "last_name"])
    ftn = pd.DataFrame(columns=["game_id", "play_id", "is_trick_play", "is_rpo", "is_screen_pass",
                                "is_play_action", "is_qb_out_of_pocket", "is_qb_sneak",
                                "n_defense_box", "n_blitzers", "n_pass_rushers"])
    out = library.build_library(seq, ftn, pd.DataFrame(), PlayerDirectory(players, rosters))
    return out.set_index("play_id")


def test_penalty_yards_are_included(lib):
    play = lib.loc[100]
    assert play["yds"] == 20
    assert play["fl"] & FL_PENALTY and play["fl"] & FL_FIRST_DOWN


def test_interception_tov_is_offense_perspective(lib):
    play = lib.loc[110]
    assert play["fl"] & FL_INT
    # yl_start + yl_new_defense - 100 = 55 + 70 - 100
    assert play["tov"] == 25
    assert play["yds"] == 0
    # The clock stopped (turnover): measured duration = 6 s.
    assert play["dur"] == 60


def test_touchdown_yards_equal_yl(lib):
    play = lib.loc[120]
    assert play["yds"] == play["yl"] == 70
    assert play["fl"] & FL_TD


def test_return_touchdown_puts_ball_in_offense_end_zone(lib):
    play = lib.loc[150]
    assert play["fl"] & FL_DEF_TD and play["fl"] & FL_INT
    assert not play["fl"] & FL_TD
    assert play["tov"] == 75 - 100


def test_fumble_kept_by_offense_is_not_a_turnover(lib):
    play = lib.loc[180]
    assert play["yds"] == 2 and play["tov"] == 0
    assert not play["fl"] & FL_FUMBLE_LOST


def test_wiped_out_play_and_pre_snap_exclusion(lib):
    play = lib.loc[190]
    assert play["fl"] & FL_NO_PLAY and play["fl"] & FL_AUTO_FIRST and play["fl"] & FL_PENALTY
    assert play["yds"] == 20
    assert play["call_id"] == "deep_r"   # call recovered from the description
    assert 200 not in lib.index          # false start


def test_safety(lib):
    play = lib.loc[210]
    assert play["fl"] & FL_SAFETY and play["fl"] & FL_SACK
    assert play["yds"] == play["yl"] - 100


def test_two_point_try(lib):
    play = lib.loc[220]
    assert (play["two"], play["down"], play["yl"], play["ytg"], play["yds"]) == (1, 0, 2, 2, 2)
    assert play["fl"] & FL_TD


def test_non_library_rows_excluded(lib):
    assert set(lib["play_type"]) <= {"run", "pass", "no_play"}
    assert sorted(lib.index) == [100, 110, 120, 150, 180, 190, 210, 220]


def test_defensive_look_codes():
    look = library.defensive_look(
        part_box=[7, 8, 6, 0, 0], part_rushers=[5, 4, 4, 0, 0],
        ftn_box=[0, 0, 0, 7, np.nan], ftn_blitzers=[0, 0, 0, 0, np.nan],
        ftn_rushers=[0, 0, 0, 0, np.nan])
    assert look.tolist() == [1, 2, 3, 0, 0]
