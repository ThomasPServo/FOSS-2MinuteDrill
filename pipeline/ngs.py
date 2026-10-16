"""Optional client for the public Next Gen Stats site API, and player top speeds.

The NGS website (https://nextgenstats.nfl.com) is backed by a JSON API that answers
without authentication when requests carry the same ``accept``/``referer`` headers as the
site and a desktop browser user agent. The pipeline uses it for two things:

* **Top speeds.** ``leaders/speed/position/{POS}`` returns the fastest plays at a
  position (one entry per play, so players repeat) and is capped at ``limit=50``. Asking
  per week (``week=1..18``) returns a different top 50 every week, so for the skill and
  coverage positions we query every completed regular-season week and keep each
  player's maximum per season. Line positions only get the season-level query.
* **Current-season NGS stats.** ``statboard/{passing,rushing,receiving}`` with ``week=W``
  fills weeks that the nflverse NGS files do not have yet.

Politeness: every response is cached under ``.cache/ngs/`` (git-ignored; raw responses
are never committed, only derived numbers end up in ``web/data``), live requests are at
least one second apart, transient failures are retried with exponential backoff, and no
cookies are ever stored or sent. The whole step is optional: with ``--no-ngs-api`` only
cached responses are used, and if the API is unreachable speeds fall back to
position-group values (recorded in ``meta.json``).
"""

from __future__ import annotations

import http.cookiejar
import json
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .common import NGS_DIR, POSITION_GROUP, log

API_ROOT = "https://nextgenstats.nfl.com/api/"
HEADERS = {
    "accept": "application/json, text/plain, */*",
    "referer": "https://nextgenstats.nfl.com/stats/top-plays/fastest-ball-carriers",
    "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"),
}
MIN_INTERVAL_S = 1.1
LEADER_LIMIT = 50  # the API rejects larger values

# Queried for every completed week (fast players whose speed matters most in the engine).
WEEKLY_POSITIONS = ("QB", "RB", "WR", "TE", "CB", "FS", "SS", "S", "OLB", "ILB", "MLB")
# Queried once per season (top 50 plays of the season).
SEASON_POSITIONS = ("FB", "T", "G", "C", "DE", "DT", "NT")

MPH_TO_YDS = 1760 / 3600  # 0.48889 yards per second per mph

# Last-resort top speeds (yd/s) by rating group when the API data is unavailable.
DEFAULT_SPEED = {"QB": 8.2, "RB": 9.0, "WR": 9.3, "TE": 8.5, "OL": 7.3, "DL": 7.8,
                 "LB": 8.5, "CB": 9.3, "S": 9.0, "K": 7.5, "P": 7.5}

# Players missing from every weekly top 50 are, by construction, slower than the
# leaders, so the group fallback is a low percentile of the leaders' season maxima
# rather than their median.
GROUP_FALLBACK_PERCENTILE = 25


class _NoCookies(http.cookiejar.DefaultCookiePolicy):
    """Cookie policy that never accepts or returns a cookie."""

    def set_ok(self, cookie, request):
        return False

    def return_ok(self, cookie, request):
        return False


class NgsClient:
    """Cached, throttled GET client for the NGS site API.

    ``live=False`` serves cached responses only. After the first request that fails
    even with retries, the client stops making live requests for the rest of the build.
    """

    def __init__(self, cache_dir: Path = NGS_DIR, live: bool = True, retries: int = 4):
        self.cache_dir = cache_dir
        self.live = live
        self.retries = retries
        self.reached = False      # a live request succeeded during this build
        self.live_requests = 0
        self.cache_hits = 0
        self._last = 0.0
        self._session = requests.Session()
        self._session.cookies.set_policy(_NoCookies())

    def _cache_path(self, path: str, params: dict) -> Path:
        query = "_".join(f"{k}={params[k]}" for k in sorted(params))
        name = re.sub(r"[^A-Za-z0-9=._-]+", "_", f"{path}__{query}")
        return self.cache_dir / f"{name}.json"

    def get(self, path: str, params: dict) -> dict | None:
        """Return the decoded JSON for ``path`` with ``params``, or None if unavailable."""
        cache = self._cache_path(path, params)
        if cache.exists():
            self.cache_hits += 1
            return json.loads(cache.read_text())
        if not self.live:
            return None
        for attempt in range(self.retries):
            wait = self._last + MIN_INTERVAL_S - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.live_requests += 1
            try:
                resp = self._session.get(API_ROOT + path, params=params, headers=HEADERS,
                                         timeout=30)
            except requests.RequestException as exc:
                log.warning("NGS request error (%s): %s", exc.__class__.__name__, path)
            else:
                if resp.status_code == 200:
                    data = resp.json()
                    self.cache_dir.mkdir(parents=True, exist_ok=True)
                    cache.write_text(resp.text)
                    self.reached = True
                    return data
                if resp.status_code not in (429, 500, 502, 503, 504):
                    log.warning("NGS %s for %s %s", resp.status_code, path, params)
                    return None
            time.sleep(2 ** (attempt + 1))
        log.warning("NGS API unreachable; using cached responses only from now on")
        self.live = False
        return None


def _leader_rows(data: dict | None, season: int) -> list[dict]:
    if not data:
        return []
    rows = []
    for item in data.get("leaders", []):
        leader = item.get("leader") or {}
        if leader.get("gsisId") and leader.get("maxSpeed"):
            rows.append({"gsis_id": leader["gsisId"], "season": season,
                         "mph": float(leader["maxSpeed"]),
                         "position": leader.get("position")})
    return rows


def fetch_top_speeds(client: NgsClient, weeks_by_season: dict[int, list[int]]) -> pd.DataFrame:
    """Max NGS speed (mph) per player and season: columns gsis_id, season, mph, group."""
    rows: list[dict] = []
    for season, weeks in sorted(weeks_by_season.items()):
        base = {"limit": LEADER_LIMIT, "season": season, "seasonType": "REG"}
        for pos in WEEKLY_POSITIONS:
            for week in weeks:
                rows += _leader_rows(client.get(f"leaders/speed/position/{pos}",
                                                {**base, "week": week}), season)
        for pos in WEEKLY_POSITIONS + SEASON_POSITIONS:
            rows += _leader_rows(client.get(f"leaders/speed/position/{pos}", base), season)
        log.info("NGS speeds %s: %d leader entries so far (%d live requests)",
                 season, len(rows), client.live_requests)
    if not rows:
        return pd.DataFrame(columns=["gsis_id", "season", "mph", "group"])
    speeds = pd.DataFrame(rows)
    speeds = (speeds.sort_values("mph", ascending=False)
              .drop_duplicates(["gsis_id", "season"]).reset_index(drop=True))
    speeds["group"] = speeds["position"].map(POSITION_GROUP)
    return speeds[["gsis_id", "season", "mph", "group"]]


class SpeedTable:
    """Top speed (yd/s) lookup: player's season max, else prior season, else group value."""

    def __init__(self, speeds: pd.DataFrame):
        self._by_player = {(r.gsis_id, int(r.season)): float(r.mph) * MPH_TO_YDS
                           for r in speeds.itertuples()}
        self.group_fallback = dict(DEFAULT_SPEED)
        for group, mph in speeds.groupby("group")["mph"]:
            if len(mph) >= 10:
                value = np.percentile(mph, GROUP_FALLBACK_PERCENTILE) * MPH_TO_YDS
                self.group_fallback[group] = round(float(value), 2)

    def __len__(self) -> int:
        return len(self._by_player)

    def speed(self, gsis_id: str, season: int, group: str) -> float:
        for s in (season, season - 1):
            if (gsis_id, s) in self._by_player:
                return round(self._by_player[(gsis_id, s)], 2)
        return self.group_fallback.get(group, 8.5)


# statboard field -> nflverse NGS column, per stat kind (only the columns ratings use).
STATBOARD_FIELDS = {
    "passing": {"attempts": "attempts",
                "completionPercentageAboveExpectation":
                    "completion_percentage_above_expectation"},
    "rushing": {"rushAttempts": "rush_attempts",
                "rushYardsOverExpectedPerAtt": "rush_yards_over_expected_per_att"},
    "receiving": {"targets": "targets", "avgSeparation": "avg_separation",
                  "avgYACAboveExpectation": "avg_yac_above_expectation"},
}


def statboard_weeks(client: NgsClient, kind: str, season: int, weeks: list[int]) -> pd.DataFrame:
    """Weekly NGS stats from the site API in nflverse column names (fills missing weeks)."""
    fields = STATBOARD_FIELDS[kind]
    rows = []
    for week in weeks:
        data = client.get(f"statboard/{kind}",
                          {"season": season, "seasonType": "REG", "week": week})
        for stat in (data or {}).get("stats", []):
            gsis = (stat.get("player") or {}).get("gsisId")
            if gsis:
                row = {"season": season, "week": week, "player_gsis_id": gsis}
                row.update({col: stat.get(src) for src, col in fields.items()})
                rows.append(row)
    return pd.DataFrame(rows)
