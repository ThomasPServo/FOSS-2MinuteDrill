"""Download the public nflverse source files into ``.cache/nflverse/``.

Files already present are skipped, so a build only downloads what is missing (delete a
file to refresh it). A file that does not exist upstream (HTTP 404, e.g. participation
data for a season that has none yet) is logged as a warning and the build carries on.

All files come from the nflverse-data GitHub releases (CC BY 4.0; FTN charting data is
CC BY-SA 4.0) and the nfldata repository for the schedule.
"""

from __future__ import annotations

import time
from pathlib import Path

import requests

from .common import NFLVERSE_DIR, log

RELEASE_URL = "https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# (release tag, file name pattern); "{season}" patterns are fetched once per season.
SEASONAL_FILES = [
    ("pbp", "play_by_play_{season}.parquet"),
    ("pbp_participation", "pbp_participation_{season}.parquet"),
    ("ftn_charting", "ftn_charting_{season}.parquet"),
    ("weekly_rosters", "roster_weekly_{season}.parquet"),
    ("stats_player", "stats_player_week_{season}.parquet"),
    ("snap_counts", "snap_counts_{season}.parquet"),
]
STATIC_FILES = [
    ("players", "players.parquet"),
    ("nextgen_stats", "ngs_passing.parquet"),
    ("nextgen_stats", "ngs_rushing.parquet"),
    ("nextgen_stats", "ngs_receiving.parquet"),
]


def _download(url: str, dest: Path, retries: int = 3) -> bool:
    """Stream ``url`` to ``dest`` atomically. Returns False on a 404, raises on other errors."""
    for attempt in range(1, retries + 1):
        try:
            with requests.get(url, stream=True, timeout=120) as resp:
                if resp.status_code == 404:
                    return False
                resp.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                tmp.replace(dest)
                return True
        except requests.RequestException as exc:
            if attempt == retries:
                raise
            wait = 2 ** attempt
            log.warning("download failed (%s), retrying in %ss: %s", exc, wait, url)
            time.sleep(wait)
    return False


def fetch_all(seasons: list[int], cache_dir: Path = NFLVERSE_DIR) -> None:
    """Download every source file the build needs for ``seasons`` unless already cached."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    targets = [(RELEASE_URL.format(tag=tag, file=pattern.format(season=season)),
                pattern.format(season=season))
               for tag, pattern in SEASONAL_FILES for season in seasons]
    targets += [(RELEASE_URL.format(tag=tag, file=name), name) for tag, name in STATIC_FILES]
    targets.append((GAMES_URL, "games.csv"))

    for url, name in targets:
        dest = cache_dir / name
        if dest.exists():
            continue
        log.info("downloading %s", url)
        if not _download(url, dest):
            log.warning("not available upstream (404), skipping: %s", url)
