"""Validate the built files in web/data against docs/DATA.md."""

import json
from pathlib import Path

import pytest

from pipeline.calls import CALLS
from pipeline.common import SPOT_POSITIONS

DATA = Path(__file__).resolve().parents[2] / "web" / "data"
PLAY_COLUMNS = ["call", "g", "pid", "down", "ytg", "yl", "mode", "hs", "margin", "yds", "dur",
                "fl", "tov", "epa", "look", "air", "loc", "tgt", "two"]
SPOT_KEYS = {"version", "id", "cat", "game_id", "play_id", "season", "week", "type", "date",
             "home", "away", "team", "roof", "indoor", "temp", "wind", "spread", "start", "real",
             "strength", "players"}
PLAYER_KEYS = {"id", "name", "short", "pos", "num", "r", "spd"}


def load(name):
    path = DATA / name
    if not path.exists():
        pytest.skip(f"{path} not built (run python3 -m pipeline.build)")
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def index():
    return load("spots/index.json")


@pytest.fixture(scope="module")
def spot_files(index):
    return [load(f"spots/{s['id']}.json") for s in index["spots"]]


def test_calls():
    calls = load("calls.json")
    assert calls["version"] == 1
    assert calls["calls"] == CALLS


def test_plays_columns():
    plays = load("plays.json")
    cols = plays["cols"]
    assert list(cols) == PLAY_COLUMNS
    n = plays["n"]
    assert n > 100000
    for name, values in cols.items():
        assert len(values) == n, name
        assert all(type(v) is int for v in values[:5000]), name
    n_calls, n_games = len(load("calls.json")["calls"]), len(plays["games"])
    for i in range(n):
        assert 0 <= cols["call"][i] < n_calls
        assert 0 <= cols["g"][i] < n_games
        assert 0 <= cols["down"][i] <= 4 and 1 <= cols["yl"][i] <= 99
        assert cols["ytg"][i] >= 1
        assert cols["mode"][i] in (0, 1, 2) and 0 <= cols["hs"][i] <= 1800
        assert 20 <= cols["dur"][i] <= 150
        assert cols["look"][i] in (0, 1, 2, 3) and cols["loc"][i] in (0, 1, 2)
        assert 0 <= cols["tgt"][i] <= 4 and cols["two"][i] in (0, 1)
        yl, yds, fl = cols["yl"][i], cols["yds"][i], cols["fl"][i]
        if cols["two"][i]:
            assert cols["down"][i] == 0 and yl == cols["ytg"][i] == 2 and yds in (0, 2)
        elif fl & 16:
            assert yds == yl
        elif fl & 256:
            assert yds == yl - 100
        else:
            assert yl - 99 <= yds <= yl - 1
        if fl & (64 | 128):
            assert -99 <= cols["tov"][i] <= 99
            if fl & 32:
                assert cols["tov"][i] == yl - 100
        else:
            assert cols["tov"][i] == 0
    assert plays["games"] == sorted(plays["games"])


def test_special():
    sp = load("special.json")
    assert sp["fg"]["features"] == ["const", "dist", "dist2", "indoor", "wind"]
    assert len(sp["fg"]["coef"]) == 5 and 0 < sp["fg"]["blocked"] < 0.1
    for key in ("xp", "two", "onside"):
        assert 0 <= sp[key]["rate"] <= 1 and sp[key]["n"] > 0
    punt, kick = sp["punt"]["cols"], sp["kickoff"]["cols"]
    assert len(punt["yl"]) == len(punt["recv_yl"]) == len(punt["fl"]) > 1000
    assert len(kick["recv_yl"]) == len(kick["fl"]) > 1000
    assert all(0 <= v <= 100 for v in punt["recv_yl"] + kick["recv_yl"])
    assert sp["kickoff"]["seasons"] and min(sp["kickoff"]["seasons"]) >= 2025
    for tempo in ("hurry", "normal", "kill"):
        values = sp["between"][tempo]
        assert len(values) == 19 and values == sorted(values)
        assert all(3 <= v <= 40 for v in values)
    assert set(sp["dur"]) == {"run", "pass", "sack", "incomplete", "kneel", "spike"}
    fourth = sp["fourth"]
    assert len(fourth["coef"]) == 3 and all(len(r) == len(fourth["features"]) for r in fourth["coef"])
    assert all(v == 0 for v in fourth["coef"][0])
    lo, hi = sp["go2"]["margins"]
    for rows in sp["go2"]["rows"].values():
        assert len(rows) == hi - lo + 1 and all(0 <= v <= 1 for v in rows)
    assert len(sp["halftime_wp"]["coef"]) == 4
    assert sp["league"]["epa_sd_pass"] > sp["league"]["epa_sd_run"] > 0


def test_coaches():
    coaches = load("coaches.json")
    assert coaches["measures"] == ["pass", "deep", "go", "two"]
    for m in coaches["measures"]:
        assert coaches["league"][m]["sd"] > 0
    for c in coaches["coaches"]:
        assert c["teams"] and c["from"] <= c["to"]
        for m in coaches["measures"]:
            assert c[m] is None or 0 <= c[m] <= 1


def test_index(index):
    ids = [s["id"] for s in index["spots"]]
    assert len(ids) == len(set(ids))
    cats = {s["id"]: s["cat"] for s in index["spots"]}
    assert set(index["categories"]) == {"drill", "protect", "tight", "q4"}
    assert sorted(index["daily"]) == sorted(i for i in ids if cats[i] != "q4")
    assert sorted(index["survivor"]) == sorted(i for i in ids if cats[i] == "q4")
    assert 600 <= len(index["daily"]) <= 900
    assert 200 <= len(index["survivor"]) <= 400
    for s in index["spots"]:
        assert s["team"] in (s["home"], s["away"]) and set(s["score"]) == {s["home"], s["away"]}
        assert s["id"].startswith(f"{s['season']}_") and s["id"].rsplit("_", 1)[1].isdigit()


def check_player(p, unit):
    assert set(p) == PLAYER_KEYS, unit
    assert p["pos"] in SPOT_POSITIONS
    assert 40 <= p["r"] <= 99 and type(p["r"]) is int
    assert 6.0 <= p["spd"] <= 12.0
    assert p["num"] is None or 0 <= p["num"] <= 99
    assert p["name"] and p["short"]


def test_spot_files(index, spot_files):
    entries = {s["id"]: s for s in index["spots"]}
    for spot in spot_files:
        assert set(spot) == SPOT_KEYS
        entry = entries[spot["id"]]
        assert spot["id"] == f"{spot['game_id']}_{spot['play_id']}"
        for key in ("cat", "season", "week", "type", "date", "home", "away", "team"):
            assert spot[key] == entry[key]
        teams = {spot["home"], spot["away"]}
        start = spot["start"]
        assert start["pos"] in teams and set(start["score"]) == teams and set(start["to"]) == teams
        assert start["receive2h"] in teams and start["phase"] in ("snap", "kickoff", "pat")
        assert 1 <= start["down"] <= 4 and 1 <= start["yl"] <= 99 and start["ytg"] >= 1
        assert 0 <= start["clock"] <= 900 and all(0 <= t <= 3 for t in start["to"].values())
        if spot["cat"] != "q4":
            assert start["down"] == 1 and spot["team"] == start["pos"]
        real = spot["real"]
        assert set(real["coach"]) == teams and set(real["final"]) == teams
        assert real["call"] is None or real["call"] in {c["id"] for c in CALLS}
        assert set(spot["strength"]) == teams
        for values in spot["strength"].values():
            assert set(values) == {"off_pass", "off_rush", "def_pass", "def_rush"}
            assert all(abs(v) < 0.5 for v in values.values())
        assert set(spot["players"]) == teams
        for team, p in spot["players"].items():
            assert len(p["off"]) == 11 and len(p["def"]) == 11
            assert len({x["id"] for x in p["off"] + p["def"]}) == 22, (spot["id"], team)
            assert "QB" in [x["pos"] for x in p["off"]]
            assert len(p["subs"]) <= 6
            for unit in ("off", "def", "subs"):
                for x in p[unit]:
                    check_player(x, unit)
            check_player(p["k"], "k")
            check_player(p["p"], "p")
            assert p["k"]["pos"] == "K" and p["p"]["pos"] == "P"


def test_meta():
    meta = load("meta.json")
    assert {"built", "seasons", "counts", "sources", "ngs_api_reached"} <= set(meta)
    assert isinstance(meta["ngs_api_reached"], bool)
    assert any("CC BY 4.0" in s["license"] for s in meta["sources"])
    assert any("CC BY-SA 4.0" in s["license"] for s in meta["sources"])
