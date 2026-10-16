"""Build every file in ``web/data`` (see docs/DATA.md).

Usage::

    python3 -m pipeline.build [--seasons 2022-2026] [--spot-seasons 2023-2026]
                              [--out web/data] [--no-ngs-api] [--no-fetch]

Steps: download missing nflverse files (unless ``--no-fetch``), build the play library
and calls, the special-teams/clock/decision models, coach tendencies, NGS top speeds
(live API unless ``--no-ngs-api``, which uses cached responses only), then the spots
with lineups, ratings and team strength, the schedule, and ``meta.json``.
"""

from __future__ import annotations

import argparse
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import coaches, fetch, library, load, ngs, special, spots
from .calls import calls_json
from .common import REPO_ROOT, log, write_json
from .lineups import LineupBuilder
from .ratings import Ratings, player_games
from .roster import PlayerDirectory
from .strength import TeamWindows, team_plays

SOURCES = [
    {"name": "nflverse play-by-play, participation, rosters, player stats, snap counts, "
             "schedules", "url": "https://github.com/nflverse/nflverse-data",
     "license": "CC BY 4.0"},
    {"name": "FTN Data charting via nflverse", "url": "https://ftndata.com",
     "license": "CC BY-SA 4.0"},
    {"name": "Next Gen Stats via nflverse", "url": "https://nextgenstats.nfl.com",
     "license": "(c) NFL; derived values only"},
    {"name": "Next Gen Stats public site API (player top speeds)",
     "url": "https://nextgenstats.nfl.com", "license": "(c) NFL; derived values only"},
]


def season_range(text: str) -> list[int]:
    """'2022-2026' -> [2022, ..., 2026]; '2024' -> [2024]; '2022,2024' -> [2022, 2024]."""
    seasons: list[int] = []
    for part in text.split(","):
        lo, _, hi = part.partition("-")
        seasons += list(range(int(lo), int(hi or lo) + 1))
    return sorted(set(seasons))


def completed_weeks(games: pd.DataFrame, seasons: list[int]) -> dict[int, list[int]]:
    """Regular-season weeks with at least one final score, per season."""
    done = games[(games["game_type"] == "REG") & games["result"].notna()
                 & games["season"].isin(seasons)]
    return {int(s): sorted(int(w) for w in g["week"].unique()) for s, g in done.groupby("season")}


def ngs_stats(client: ngs.NgsClient, games: pd.DataFrame, seasons: list[int]) -> dict:
    """nflverse weekly NGS, with completed weeks it lacks filled from the site API."""
    out = {}
    weeks = completed_weeks(games, seasons)
    for kind in ("passing", "rushing", "receiving"):
        frame = load.load_ngs(kind)
        latest = max(seasons)
        have = set(frame.loc[frame["season"] == latest, "week"])
        missing = [w for w in weeks.get(latest, []) if w not in have]
        if missing:
            extra = ngs.statboard_weeks(client, kind, latest, missing)
            log.info("NGS %s %s: %d rows for weeks %s from the site API", kind, latest,
                     len(extra), missing)
            frame = pd.concat([frame, extra], ignore_index=True)
        out[kind] = frame
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--seasons", default="2022-2026",
                        help="seasons for the play library and models (default 2022-2026)")
    parser.add_argument("--spot-seasons", default="2023-2026",
                        help="seasons spots are drawn from (default 2023-2026)")
    parser.add_argument("--out", default=str(REPO_ROOT / "web" / "data"))
    parser.add_argument("--no-ngs-api", action="store_true",
                        help="make no live NGS API requests (cached responses still used)")
    parser.add_argument("--no-fetch", action="store_true",
                        help="do not download missing nflverse files")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    t0 = time.time()
    seasons = season_range(args.seasons)
    spot_seasons = season_range(args.spot_seasons)
    # Ratings and strength look back 17 games, so they need the season before the spots.
    data_seasons = sorted(set(seasons) | set(spot_seasons) | {min(spot_seasons) - 1})
    out = Path(args.out)

    if not args.no_fetch:
        fetch.fetch_all(data_seasons)

    log.info("loading play-by-play %s", data_seasons)
    games = load.load_games()
    seq = library.annotate(load.load_pbp(data_seasons))
    rosters = load.load_rosters(data_seasons)
    directory = PlayerDirectory(load.load_players(), rosters)
    participation = load.load_participation(data_seasons)

    log.info("building the play library")
    lib_all = library.build_library(seq, load.load_ftn(data_seasons), participation, directory)
    lib = lib_all[lib_all["season"].isin(seasons)]
    model_seq = seq[seq["season"].isin(seasons)]
    sizes = {"calls.json": write_json(out / "calls.json", calls_json()),
             "plays.json": write_json(out / "plays.json", library.plays_json(lib))}

    log.info("fitting special-teams, clock and decision models")
    special_json = special.build_special(model_seq, lib, games)
    sizes["special.json"] = write_json(out / "special.json", special_json)
    sizes["coaches.json"] = write_json(out / "coaches.json",
                                       coaches.build_coaches(model_seq, lib, games, seasons))

    log.info("Next Gen Stats (%s)", "cache only" if args.no_ngs_api else "live API")
    client = ngs.NgsClient(live=not args.no_ngs_api)
    speed_seasons = [s for s in data_seasons if s >= min(spot_seasons) - 1]
    speeds = ngs.SpeedTable(ngs.fetch_top_speeds(client, completed_weeks(games, speed_seasons)))
    ngs_frames = ngs_stats(client, games, spot_seasons)

    log.info("player production and ratings")
    pg = player_games(load.load_player_stats(data_seasons), load.load_snap_counts(data_seasons),
                      seq, lib_all, ngs_frames, games, directory, special_json["fg"]["coef"])
    context = spots.SpotContext(
        seq=seq, games=games,
        calls_by_play={(g, int(p)): c for g, p, c in
                       zip(lib_all["game_id"], lib_all["play_id"], lib_all["call_id"])},
        lineups=LineupBuilder(seq, participation, load.load_snap_counts(spot_seasons),
                              rosters, directory),
        ratings=Ratings(pg, directory), speeds=speeds,
        strength_plays=team_plays(lib_all, games), windows=TeamWindows(games),
        directory=directory)

    log.info("selecting and writing spots")
    selected = spots.select_spots(seq, spot_seasons)
    spot_dir = out / "spots"
    spot_dir.mkdir(parents=True, exist_ok=True)
    for stale in spot_dir.glob("*.json"):
        stale.unlink()
    entries, spot_bytes = [], 0
    for _, row in selected.iterrows():
        entry, spot = context.build(row)
        entries.append(entry)
        spot_bytes += write_json(spot_dir / f"{row['id']}.json", spot)
    daily = [e for e in entries if e["cat"] != "q4"]
    index = {"version": spots.SPOT_VERSION, "launch": spots.LAUNCH,
             "categories": spots.CATEGORIES, "spots": entries,
             "daily": spots.daily_schedule(daily),
             "survivor": spots.survivor_order([e for e in entries if e["cat"] == "q4"])}
    sizes["spots/index.json"] = write_json(spot_dir / "index.json", index)
    sizes["spots/<id>.json (total)"] = spot_bytes

    counts = {"plays": len(lib), "games": int(lib["game_id"].nunique()),
              "spots": len(entries), "daily": len(daily),
              "by_category": {c: sum(e["cat"] == c for e in entries) for c in spots.CATEGORIES}}
    meta = {
        "version": 1,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seasons": {"plays": seasons, "spots": spot_seasons},
        "counts": counts,
        "sources": SOURCES,
        "ngs_api_reached": bool(client.reached or client.cache_hits),
        "ngs_api": {"live_requests": client.live_requests, "reached_live": client.reached,
                    "cached_responses": client.cache_hits, "players_with_speed": len(speeds),
                    "speed_source": "ngs-api" if len(speeds) else "position-group defaults"},
    }
    sizes["meta.json"] = write_json(out / "meta.json", meta)

    for name, size in sizes.items():
        log.info("%-28s %10.1f KB", name, size / 1024)
    log.info("done in %.0f s: %d plays, %d spots (%s)", time.time() - t0, len(lib),
             len(entries), counts["by_category"])


if __name__ == "__main__":
    main()
