"""Read the cached nflverse files into pandas DataFrames.

Only the columns the pipeline uses are read from the (very wide) play-by-play files.
Seasonal files that are missing (e.g. participation for a season that has none) are
skipped with a warning; callers handle the absent seasons.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .common import NFLVERSE_DIR, log

PBP_COLUMNS = [
    # identity and game context
    "game_id", "play_id", "season", "season_type", "week", "game_date", "home_team",
    "away_team", "order_sequence", "roof", "temp", "wind", "spread_line", "home_coach",
    "away_coach", "home_opening_kickoff",
    # situation
    "posteam", "defteam", "qtr", "game_half", "quarter_seconds_remaining",
    "half_seconds_remaining", "game_seconds_remaining", "down", "ydstogo", "yardline_100",
    "score_differential", "posteam_score", "defteam_score", "total_home_score",
    "total_away_score", "home_timeouts_remaining", "away_timeouts_remaining", "fixed_drive",
    "fixed_drive_result", "no_huddle",
    # play
    "desc", "play_type", "yards_gained", "pass", "rush", "qb_kneel", "qb_spike", "qb_scramble",
    "aborted_play", "pass_length", "pass_location", "air_yards", "run_location", "run_gap",
    "incomplete_pass", "sack", "interception", "fumble_lost", "safety", "touchdown", "td_team",
    "out_of_bounds", "first_down", "first_down_penalty", "penalty", "penalty_team",
    "penalty_yards", "penalty_type", "timeout", "timeout_team", "epa", "passer_id",
    "receiver_id", "rusher_id", "passer_player_id", "receiver_player_id", "rusher_player_id",
    # kicking
    "field_goal_result", "extra_point_result", "two_point_attempt", "two_point_conv_result",
    "punt_blocked", "touchback", "punt_out_of_bounds", "punt_downed", "punt_fair_catch",
    "kickoff_out_of_bounds", "own_kickoff_recovery", "kicker_player_id", "punter_player_id",
]


def _read_seasonal(pattern: str, seasons: list[int], columns: list[str] | None = None,
                   cache_dir: Path = NFLVERSE_DIR) -> pd.DataFrame:
    frames = []
    for season in seasons:
        path = cache_dir / pattern.format(season=season)
        if not path.exists():
            log.warning("missing %s (season %s skipped)", path.name, season)
            continue
        frames.append(pd.read_parquet(path, columns=columns))
    if not frames:
        raise FileNotFoundError(f"no {pattern} files for seasons {seasons} in {cache_dir}")
    return pd.concat(frames, ignore_index=True)


def load_pbp(seasons: list[int]) -> pd.DataFrame:
    """Play-by-play rows for ``seasons`` in game order (by ``order_sequence``)."""
    pbp = _read_seasonal("play_by_play_{season}.parquet", seasons, PBP_COLUMNS)
    pbp = pbp.sort_values(["season", "game_id", "order_sequence"], kind="stable")
    pbp["play_id"] = pbp["play_id"].astype(int)
    return pbp.reset_index(drop=True)


def load_participation(seasons: list[int]) -> pd.DataFrame:
    """Participation rows (on-field players per snap). Seasons without a file are absent."""
    present = [s for s in seasons
               if (NFLVERSE_DIR / f"pbp_participation_{s}.parquet").exists()]
    if not present:
        return pd.DataFrame()
    part = _read_seasonal("pbp_participation_{season}.parquet", present)
    part = part.rename(columns={"nflverse_game_id": "game_id"})
    part["play_id"] = part["play_id"].astype(int)
    return part


def load_ftn(seasons: list[int]) -> pd.DataFrame:
    """FTN charting flags keyed by (game_id, play_id)."""
    ftn = _read_seasonal("ftn_charting_{season}.parquet", seasons)
    ftn = ftn.rename(columns={"nflverse_game_id": "game_id", "nflverse_play_id": "play_id"})
    return ftn.drop_duplicates(["game_id", "play_id"])


def load_rosters(seasons: list[int]) -> pd.DataFrame:
    return _read_seasonal("roster_weekly_{season}.parquet", seasons)


def load_player_stats(seasons: list[int]) -> pd.DataFrame:
    return _read_seasonal("stats_player_week_{season}.parquet", seasons)


def load_snap_counts(seasons: list[int]) -> pd.DataFrame:
    return _read_seasonal("snap_counts_{season}.parquet", seasons)


def load_players() -> pd.DataFrame:
    return pd.read_parquet(NFLVERSE_DIR / "players.parquet")


def load_ngs(kind: str) -> pd.DataFrame:
    """Weekly NGS stats (``kind`` = passing, rushing or receiving); season-total rows dropped."""
    ngs = pd.read_parquet(NFLVERSE_DIR / f"ngs_{kind}.parquet")
    return ngs[ngs["week"] > 0].reset_index(drop=True)


def load_games() -> pd.DataFrame:
    return pd.read_csv(NFLVERSE_DIR / "games.csv")
