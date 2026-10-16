"""Situation mode (docs/DATA.md): 1 hurry, 2 kill, 0 normal."""

import pytest

from pipeline.common import MODE_HURRY, MODE_KILL, MODE_NORMAL, game_mode


@pytest.mark.parametrize("second_half, hs, margin, expected", [
    # first half: hurry inside 2:00 regardless of score
    (False, 120, 0, MODE_HURRY), (False, 121, -3, MODE_NORMAL), (False, 30, 14, MODE_HURRY),
    # first half never kills
    (False, 200, 10, MODE_NORMAL),
    # second half, trailing: hurry inside 5:00; down 9+: inside 10:00
    (True, 300, -1, MODE_HURRY), (True, 301, -1, MODE_NORMAL),
    (True, 600, -9, MODE_HURRY), (True, 601, -9, MODE_NORMAL), (True, 600, -8, MODE_NORMAL),
    # second half, tied: hurry inside 2:00 only
    (True, 120, 0, MODE_HURRY), (True, 121, 0, MODE_NORMAL),
    # second half, leading: kill inside 6:00
    (True, 360, 1, MODE_KILL), (True, 361, 1, MODE_NORMAL), (True, 20, 21, MODE_KILL),
])
def test_mode(second_half, hs, margin, expected):
    assert int(game_mode(second_half, hs, margin)) == expected


def test_mode_is_vectorised():
    out = game_mode([False, True, True], [100, 100, 100], [0, -3, 3])
    assert out.tolist() == [MODE_HURRY, MODE_HURRY, MODE_KILL]
