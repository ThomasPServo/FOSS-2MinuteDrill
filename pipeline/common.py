"""Shared paths, constants and small helpers used across the pipeline."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = REPO_ROOT / ".cache"
NFLVERSE_DIR = CACHE_DIR / "nflverse"
NGS_DIR = CACHE_DIR / "ngs"

log = logging.getLogger("pipeline")

# Situation modes (docs/DATA.md, "mode").
MODE_NORMAL, MODE_HURRY, MODE_KILL = 0, 1, 2

# plays.json ``fl`` bits (docs/DATA.md).
FL_PENALTY, FL_AUTO_FIRST, FL_INCOMPLETE, FL_OUT_OF_BOUNDS = 1, 2, 4, 8
FL_TD, FL_DEF_TD, FL_INT, FL_FUMBLE_LOST = 16, 32, 64, 128
FL_SAFETY, FL_SACK, FL_SCRAMBLE, FL_NO_PLAY, FL_FIRST_DOWN = 256, 512, 1024, 2048, 4096

# Position -> rating/speed group. Covers participation, roster, snap-count and NGS labels.
POSITION_GROUP = {
    "QB": "QB",
    "RB": "RB", "HB": "RB", "FB": "RB",
    "WR": "WR",
    "TE": "TE",
    "T": "OL", "G": "OL", "C": "OL", "OT": "OL", "OG": "OL", "OL": "OL", "LS": "OL",
    "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL", "EDGE": "DL",
    "OLB": "LB", "ILB": "LB", "MLB": "LB", "LB": "LB",
    "CB": "CB", "DB": "CB",
    "FS": "S", "SS": "S", "S": "S", "SAF": "S",
    "K": "K", "PK": "K",
    "P": "P",
}

# Positions allowed in spot files (docs/DATA.md) and how other labels map onto them.
SPOT_POSITIONS = {"QB", "RB", "FB", "WR", "TE", "T", "G", "C", "DE", "DT", "NT", "OLB", "ILB",
                  "MLB", "LB", "CB", "FS", "SS", "S", "DB", "K", "P"}
POSITION_ALIASES = {"HB": "RB", "OT": "T", "OG": "G", "OL": "G", "LS": "C", "DL": "DT",
                    "EDGE": "DE", "SAF": "S", "PK": "K"}


def spot_position(pos: str | None, fallback: str = "WR") -> str:
    """Normalise any position label to one of ``SPOT_POSITIONS``."""
    if not isinstance(pos, str) or not pos:
        return fallback
    pos = POSITION_ALIASES.get(pos, pos)
    return pos if pos in SPOT_POSITIONS else fallback


def game_mode(second_half, hs, margin) -> np.ndarray:
    """Situation mode at the snap, exactly as defined in docs/DATA.md.

    ``second_half`` is truthy in the second half and overtime, ``hs`` is seconds left in
    the half (or overtime period) and ``margin`` is offense score minus defense score.
    Accepts scalars or arrays; returns an int array.
    """
    second_half = np.asarray(second_half, dtype=bool)
    hs = np.asarray(hs, dtype=float)
    margin = np.asarray(margin, dtype=float)
    first_half = ~second_half
    hurry = ((first_half & (hs <= 120))
             | (second_half & (margin < 0) & (hs <= 300))
             | (second_half & (margin == 0) & (hs <= 120))
             | (second_half & (margin <= -9) & (hs <= 600)))
    kill = ~hurry & second_half & (margin > 0) & (hs <= 360)
    return np.where(hurry, MODE_HURRY, np.where(kill, MODE_KILL, MODE_NORMAL)).astype(int)


def is_second_half(game_half: pd.Series) -> pd.Series:
    """nflverse ``game_half`` ('Half1', 'Half2', 'Overtime') -> bool (OT counts as 2nd half)."""
    return game_half.ne("Half1")


def write_json(path: Path, obj) -> int:
    """Write compact JSON (no indentation) and return the file size in bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    path.write_text(text, encoding="utf-8")
    return path.stat().st_size


def int_list(values) -> list[int]:
    """Convert an array-like of numbers (NaN -> 0) to a list of Python ints."""
    arr = np.nan_to_num(np.asarray(values, dtype=float), nan=0.0)
    return np.rint(arr).astype(np.int64).tolist()


def none_if_nan(value):
    """Return ``None`` for NaN/NA so values serialise as JSON null."""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value
