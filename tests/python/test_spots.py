"""Spot selection and the daily schedule."""

import pandas as pd

from pipeline import spots

TEAMS = ["KC", "BUF", "DET", "PHI", "SF", "BAL", "LA", "GB"]


def entries(n=120):
    return [{"id": f"s{i}", "team": TEAMS[i % 8], "home": TEAMS[i % 8], "away": TEAMS[(i + 3) % 8],
             "cat": ["drill", "protect", "tight"][i % 3], "season": 2023 + i % 4} for i in range(n)]


def test_schedule_is_deterministic_permutation():
    e = entries()
    first = spots.daily_schedule(e)
    assert first == spots.daily_schedule(e)
    assert sorted(first) == sorted(x["id"] for x in e)


def test_schedule_avoids_adjacent_repeats():
    e = entries()
    by_id = {x["id"]: x for x in e}
    order = [by_id[i] for i in spots.daily_schedule(e)]
    pairs = list(zip(order, order[1:]))
    assert sum(a["team"] == b["team"] for a, b in pairs) == 0
    assert sum(a["cat"] == b["cat"] for a, b in pairs) <= 2


def test_balanced_pick_spreads_seasons_and_teams():
    rows = []
    for season, count in ((2023, 60), (2024, 30), (2025, 10)):
        for i in range(count):
            rows.append({"game_id": f"{season}_{i:02d}", "play_id": i, "season": season,
                         "team": TEAMS[i % 8], "score": 1 - i / 100})
    cands = pd.DataFrame(rows)
    picked = spots.balanced_pick(cands, 50)
    assert len(picked) == 50
    assert picked.groupby("season").size().to_dict() == {2023: 30, 2024: 15, 2025: 5}
    # Round-robin over teams: no team gets more than its fair share plus one per season.
    per_team = picked[picked["season"] == 2023].groupby("team").size()
    assert per_team.max() - per_team.min() <= 1
