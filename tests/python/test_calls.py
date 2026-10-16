"""The call menu and the play classifier, on hand-made rows."""

import numpy as np
import pandas as pd
import pytest

from pipeline.calls import CALLS, CLASSIFY_COLUMNS, RULE_ORDER, calls_json, classify, \
    fill_locations_from_desc

BASE = {"is_pass": False, "is_run": False, "scramble": False, "desc": "", "passer_pos": None,
        "rusher_pos": None, "air_yards": np.nan, "hs": 900, "pass_length": None,
        "pass_location": None, "run_location": None, "run_gap": None, "trick": False,
        "rpo": False, "screen": False, "play_action": False, "out_of_pocket": False,
        "sneak": False}


def call_of(**fields) -> str:
    row = {**BASE, **fields}
    return classify(pd.DataFrame([row], columns=CLASSIFY_COLUMNS))[0]


def qb_pass(**fields) -> str:
    return call_of(is_pass=True, passer_pos="QB", **fields)


def rb_run(**fields) -> str:
    return call_of(is_run=True, rusher_pos="RB", **fields)


def test_menu_is_complete_and_unique():
    ids = [c["id"] for c in CALLS]
    assert len(ids) == 26 and len(set(ids)) == 26
    assert set(ids) == set(RULE_ORDER)
    for call in CALLS:
        assert call["family"] in {"run", "pass", "rpo", "trick"}
        assert call["kind"] in {"run", "pass"}
        assert call["dir"] in {"left", "middle", "right", None}
        assert call.get("depth") in {None, "short", "deep", "screen", "hail"}
        if call["kind"] == "pass":
            assert "depth" in call
    assert calls_json()["calls"] is CALLS


@pytest.mark.parametrize("fields, expected", [
    ({"pass_length": "short", "pass_location": "left"}, "short_l"),
    ({"pass_length": "short", "pass_location": "middle"}, "short_m"),
    ({"pass_length": "short", "pass_location": "right"}, "short_r"),
    ({"pass_length": "deep", "pass_location": "left", "air_yards": 25}, "deep_l"),
    ({"pass_length": "deep", "pass_location": "middle", "air_yards": 25}, "deep_m"),
    ({"pass_length": "deep", "pass_location": "right", "air_yards": 25}, "deep_r"),
    ({}, "short_m"),                                    # sack / throwaway: no location
    ({"scramble": True}, "short_m"),                    # scramble
    ({"screen": True, "pass_location": "left"}, "screen"),
    ({"play_action": True, "air_yards": 22, "pass_length": "deep"}, "pa_deep"),
    ({"play_action": True, "air_yards": 6}, "pa_short"),
    ({"out_of_pocket": True, "pass_location": "right"}, "rollout"),
    ({"out_of_pocket": True, "scramble": True}, "short_m"),  # a scramble is not a rollout
    ({"rpo": True, "air_yards": 3}, "rpo_pass"),
    ({"air_yards": 52, "hs": 4, "pass_length": "deep"}, "hail_mary"),
    ({"air_yards": 52, "hs": 400, "pass_length": "deep"}, "deep_m"),
    ({"desc": "Hail Mary pass deep middle", "hs": 400}, "hail_mary"),
    ({"trick": True, "desc": "Flea flicker. 9-J.Burrow pass deep left"}, "flea_flicker"),
    ({"trick": True, "desc": "Direct snap to 33-J.Williams. 10-B.Nix pass deep middle"},
     "flea_flicker"),
])
def test_pass_rules(fields, expected):
    assert qb_pass(**fields) == expected


@pytest.mark.parametrize("fields, expected", [
    ({"run_gap": "end", "run_location": "left"}, "run_out_l"),
    ({"run_gap": "end", "run_location": "right"}, "run_out_r"),
    ({"run_gap": "tackle", "run_location": "left"}, "run_tackle_l"),
    ({"run_gap": "tackle", "run_location": "right"}, "run_tackle_r"),
    ({"run_gap": "guard", "run_location": "left"}, "run_guard_l"),
    ({"run_gap": "guard", "run_location": "right"}, "run_guard_r"),
    ({"run_location": "middle"}, "run_middle"),
    ({}, "run_middle"),
    ({"rpo": True, "run_gap": "end", "run_location": "left"}, "rpo_run"),
    ({"trick": True, "desc": "Direct snap to 24-N.Chubb. 24-N.Chubb up the middle"},
     "direct_snap"),
])
def test_run_rules(fields, expected):
    assert rb_run(**fields) == expected


def test_quarterback_and_trick_runs():
    assert call_of(is_run=True, rusher_pos="QB", sneak=True) == "qb_sneak"
    assert call_of(is_run=True, rusher_pos="QB", run_gap="end", run_location="left") == "qb_run"
    assert call_of(is_run=True, rusher_pos="WR", run_gap="end", run_location="right") == "end_around"
    assert call_of(is_run=True, rusher_pos="WR", trick=True) == "end_around"


def test_non_quarterback_passes():
    assert call_of(is_pass=True, passer_pos="WR", pass_length="deep",
                   pass_location="left") == "receiver_pass"
    # A direct snap to a receiver who throws is a receiver pass, not a flea flicker.
    assert call_of(is_pass=True, passer_pos="WR", trick=True,
                   desc="Direct snap to 1-M.Nabers. 1-M.Nabers pass incomplete") == "receiver_pass"


def test_first_matching_rule_wins():
    # Screen beats play action and location; play action beats rollout.
    assert qb_pass(screen=True, play_action=True, pass_location="left") == "screen"
    assert qb_pass(play_action=True, out_of_pocket=True, air_yards=4) == "pa_short"
    # RPO beats screen.
    assert qb_pass(rpo=True, screen=True) == "rpo_pass"


def test_locations_from_no_play_descriptions():
    df = pd.DataFrame({
        "desc": ["(5:44) 8-L.Jackson pass incomplete deep right to 4-Z.Flowers. PENALTY ...",
                 "(2:46) 1-R.White left end to NO 26 for -2 yards. PENALTY ...",
                 "(1:00) 28-J.Mixon up the middle to HOU 30 for 4 yards. PENALTY ...",
                 "TWO-POINT CONVERSION ATTEMPT. 6-J.Conner rushes right guard."],
        "pass_length": [None] * 4, "pass_location": [None] * 4,
        "run_location": [None] * 4, "run_gap": [None] * 4,
    })
    out = fill_locations_from_desc(df)
    assert list(out["pass_length"])[:1] == ["deep"]
    assert list(out["pass_location"])[:1] == ["right"]
    assert list(out["run_location"])[1:] == ["left", "middle", "right"]
    assert list(out["run_gap"])[1] == "end" and list(out["run_gap"])[3] == "guard"
