# Data contract

The Python pipeline (`pipeline/`) turns public nflverse data and the public Next Gen
Stats API into static JSON files under `web/data/`. The browser engine (`web/js/engine/`)
reads only these files. This document is the contract between the two: change both sides
together and bump `version` in the file you change.

All JSON is written compactly (no indentation). Columnar tables are objects of equal-length
arrays (`cols`), which gzip well and load fast.

## Conventions

| Term | Meaning |
| --- | --- |
| `yl` | Yards from the **opponent's** goal line for the team with the ball (nflverse `yardline_100`), 1–99. A touchdown is reaching 0; a safety is being tackled at 100. |
| `ytg` | Yards to go for a first down (equals `yl` when goal to go). |
| `clock` | Seconds left in the **quarter**. |
| `hs` | Seconds left in the **half** (nflverse `half_seconds_remaining`). |
| `margin` | Score of the team with the ball minus the other team's score. |
| team keys | nflverse abbreviations (`KC`, `LA`, `LV`, `WAS`, ...). |
| `mode` | Game-situation mode at the snap: `1` hurry, `2` kill, `0` normal (see below). |

`mode` is computed identically by the pipeline and the engine:

* **hurry (1)**: first half with `hs <= 120`; or second half and the offense trails with
  `hs <= 300`; or second half, tied, `hs <= 120`; or second half and trailing by 9+ with
  `hs <= 600`.
* **kill (2)**: otherwise, second half, the offense leads, and `hs <= 360`.
* **normal (0)**: everything else.

Overtime counts as the second half (`hs` = seconds left in the overtime period).

Situation buckets used to group plays (engine side, documented here so both agree):

* field zone by `yl`: edges `[3, 10, 20, 40, 60, 80]` → zones 0..6
  (`yl <= 3`, `<= 10`, `<= 20`, `<= 40`, `<= 60`, `<= 80`, else).
* distance by `ytg`: edges `[2, 5, 10]` → 0..3 (`<= 2`, `<= 5`, `<= 10`, else).
* down: 1, 2, 3+ (fourth downs are grouped with third).

## `calls.json`

```json
{
  "version": 1,
  "calls": [
    {"id": "run_out_l", "label": "Outside run left", "family": "run", "kind": "run",
     "dir": "left", "say": "runs outside to the left"}
  ]
}
```

* `family`: `run`, `pass`, `rpo` or `trick` (menu grouping).
* `kind`: `run` or `pass` (how the call counts in stats and the coach comparison).
* `dir`: `left`, `middle`, `right` or `null`.
* optional `depth`: `short`, `deep`, `screen`, `hail` for passes.
* The order of `calls` defines the integer call index used in `plays.json`.

The call set (26 calls) and how each real play is assigned to one:

| id | family | rule (first match wins, in this order) |
| --- | --- | --- |
| `flea_flicker` | trick | FTN `is_trick_play` and pass and description mentions flea flicker, or a backward pass/lateral to the QB before the throw |
| `receiver_pass` | trick | pass thrown by a non-QB (passer position not QB) |
| `end_around` | trick | run by a WR (rusher position WR) |
| `direct_snap` | trick | FTN `is_trick_play` run by a non-QB with "Direct snap" in the description, or other FTN trick runs |
| `hail_mary` | pass | pass with `air_yards >= 40` and `hs <= 30`, or "Hail Mary" in the description |
| `rpo_pass` | rpo | FTN `is_rpo` and pass |
| `rpo_run` | rpo | FTN `is_rpo` and run |
| `screen` | pass | FTN `is_screen_pass` |
| `pa_deep` | pass | FTN `is_play_action` and `air_yards >= 15` |
| `pa_short` | pass | FTN `is_play_action` (other) |
| `rollout` | pass | FTN `is_qb_out_of_pocket` on a called pass that is not a scramble |
| `deep_l` / `deep_m` / `deep_r` | pass | `pass_length == deep` (air yards 15+) by `pass_location` |
| `short_l` / `short_m` / `short_r` | pass | other passes by `pass_location`; sacks, scrambles and throwaways with no location go to `short_m` |
| `qb_sneak` | run | FTN `is_qb_sneak` |
| `qb_run` | run | designed QB run (rusher is the QB, not a scramble, not a kneel) |
| `run_out_l` / `run_out_r` | run | `run_gap == end` by side |
| `run_tackle_l` / `run_tackle_r` | run | `run_gap == tackle` by side |
| `run_guard_l` / `run_guard_r` | run | `run_gap == guard` by side |
| `run_middle` | run | `run_location == middle` (or no gap/location) |

## `plays.json` — the play library

Every real snap of a called run or pass (2022 season onward, regular season and playoffs),
plus post-snap accepted penalties on such plays. Kneels, spikes, pre-snap penalties, kicks
and aborted snaps are excluded.

```json
{
  "version": 1,
  "n": 165000,
  "games": ["2022_01_BUF_LA", "..."],
  "cols": {
    "call": [], "g": [], "pid": [],
    "down": [], "ytg": [], "yl": [], "mode": [], "hs": [], "margin": [],
    "yds": [], "dur": [], "fl": [], "tov": [], "epa": [],
    "look": [], "air": [], "loc": [], "tgt": [], "two": []
  }
}
```

| column | type | meaning |
| --- | --- | --- |
| `call` | int | index into `calls.json` |
| `g`, `pid` | int | index into `games`, and nflverse `play_id` (provenance: "this snap happened in ...") |
| `down`, `ytg`, `yl`, `mode`, `hs`, `margin` | int | situation at the snap (two-point tries: `down` 0, `ytg` = `yl` = 2) |
| `yds` | int | net yards for the offense from the line of scrimmage, including sack losses and the yardage of an accepted penalty. On a touchdown this equals `yl` (stopped by the end zone). |
| `dur` | int | play duration in tenths of a second (snap to whistle). Measured where the clock stopped right after the play, otherwise estimated (see pipeline). |
| `fl` | int | bit flags, below |
| `tov` | int | turnovers only: offense-perspective net yards from the line of scrimmage to the spot where the defense takes over at its next snap (`yl_start + yl_new_defense - 100`). 0 otherwise. |
| `epa` | int | nflverse EPA × 100 (used to tilt draws toward better/worse outcomes) |
| `look` | int | defensive look at the snap: `0` base, `1` blitz (5+ rushers or FTN blitzers ≥ 1), `2` loaded box (8+ in the box), `3` light box (≤ 6 in the box, no blitz) |
| `air` | int | air yards (passes), 0 otherwise |
| `loc` | int | `0` left, `1` middle, `2` right (pass or run location) |
| `tgt` | int | position group of the target/ball carrier: `0` QB, `1` RB/FB, `2` WR, `3` TE, `4` other/none |
| `two` | int | `1` if the snap was a two-point try |

Flag bits (`fl`):

| bit | value | meaning |
| --- | --- | --- |
| 0 | 1 | accepted penalty (yardage included in `yds`) |
| 1 | 2 | automatic first down by penalty |
| 2 | 4 | incomplete pass |
| 3 | 8 | ball carrier went out of bounds |
| 4 | 16 | offensive touchdown |
| 5 | 32 | defensive touchdown (return) |
| 6 | 64 | interception |
| 7 | 128 | fumble lost |
| 8 | 256 | safety |
| 9 | 512 | sack |
| 10 | 1024 | QB scramble |
| 11 | 2048 | no play (penalty wiped out the play; the down is replayed unless bit 1 is set) |
| 12 | 4096 | first down gained (by yards or penalty) |

## `special.json` — kicking, clock and policy models

```json
{
  "version": 1,
  "fg":      {"features": ["const", "dist", "dist2", "indoor", "wind"], "coef": [], "blocked": 0.012, "n": 0},
  "xp":      {"rate": 0.95, "blocked": 0.01, "n": 0},
  "two":     {"rate": 0.48, "n": 0},
  "punt":    {"cols": {"yl": [], "recv_yl": [], "fl": []}},
  "kickoff": {"cols": {"recv_yl": [], "fl": []}, "seasons": [2025, 2026]},
  "onside":  {"rate": 0.0, "n": 0},
  "between": {"hurry": [], "normal": [], "kill": []},
  "dur":     {"run": 0, "pass": 0, "sack": 0, "incomplete": 0, "kneel": 0, "spike": 0},
  "fourth":  {"classes": ["go", "fg", "punt"], "features": [], "coef": [[], [], []]},
  "go2":     {"margins": [-20, 20], "rows": {"early": [], "late": []}},
  "halftime_wp": {"features": ["const", "margin", "receive2h", "spread"], "coef": []},
  "league":  {"epa_sd_pass": 0, "epa_sd_run": 0}
}
```

* `fg`: logistic make probability. `dist` = `yl + 18`, `dist2 = dist^2 / 100`, `indoor` 0/1,
  `wind` mph (0 indoors). `p = 1 / (1 + exp(-(coef · x)))`.
* `punt.cols`: `yl` of the punting team at the snap; `recv_yl` = the receiving team's `yl` at its
  next snap (100 − its distance from its own goal); `fl` bits: 1 blocked, 2 touchback,
  4 return touchdown, 8 punting team recovered (muff/fumble), 16 out of bounds / downed / fair catch.
* `kickoff.cols`: `recv_yl` as above; `fl` bits: 2 touchback, 4 return touchdown,
  8 kicking team recovered, 16 out of bounds. Only seasons under the current kickoff rule.
* `onside.rate`: share of onside kicks the kicking team recovered (2022 onward).
* `between`: the 5th, 10th, ..., 95th percentiles (19 numbers) of seconds that run off between
  the end of a play and the next snap with the clock running, by tempo.
* `dur`: median play durations in seconds, as fallbacks.
* `fourth`: multinomial logistic for NFL fourth-down decisions. `features` names the inputs in
  order (documented in `pipeline/models.py`); `coef[k]` are the weights for class `k`
  (class 0 is the reference with all-zero weights).
* `go2`: smoothed share of touchdowns followed by a two-point try, by the scoring team's
  margin **after the touchdown, before the try** (index 0 = `margins[0]`), for `early`
  (more than 5:00 left in the game) and `late` (5:00 or less, second half).
* `halftime_wp`: logistic win probability for the team in question at halftime from its
  margin, whether it receives the second-half kickoff (1/0), and its point spread
  (positive = favored).
* `league`: standard deviations of play EPA, used to scale team-strength tilts.

## `spots/index.json`

```json
{
  "version": 1,
  "launch": "2026-10-16",
  "categories": {"drill": "Two-minute drill", "protect": "Protect the lead",
                 "tight": "Tied, or the end of the half", "q4": "Fourth quarter"},
  "spots": [
    {"id": "2024_05_KC_NO_3456", "cat": "drill", "season": 2024, "week": 5, "type": "REG",
     "date": "2024-10-07", "home": "NO", "away": "KC", "team": "KC", "qtr": 4, "clock": 118,
     "score": {"KC": 20, "NO": 23}, "yl": 75}
  ],
  "daily": ["<spot ids>"],
  "survivor": ["<spot ids with cat q4>"]
}
```

* `daily` is the schedule: day `d` (days since `launch`, UTC date) plays
  `daily[d mod len(daily)]`. It holds only drill/protect/tight spots, shuffled with a fixed
  seed so neighbouring days differ in team, season and category.
* `team` is the side the player coaches (the team with the ball at the start, except q4 spots,
  where it is the trailing team, or the team with the ball if tied).

## `spots/<id>.json`

```json
{
  "version": 1,
  "id": "2024_05_KC_NO_3456", "cat": "drill", "game_id": "2024_05_KC_NO", "play_id": 3456,
  "season": 2024, "week": 5, "type": "REG", "date": "2024-10-07",
  "home": "NO", "away": "KC", "team": "KC",
  "roof": "dome", "indoor": true, "temp": 72, "wind": 0, "spread": -2.5,
  "start": {"qtr": 4, "clock": 118, "score": {"KC": 20, "NO": 23}, "pos": "KC",
            "down": 1, "ytg": 10, "yl": 75, "to": {"KC": 2, "NO": 3},
            "receive2h": "NO", "phase": "snap"},
  "real": {"coach": {"KC": "Andy Reid", "NO": "Dennis Allen"}, "call": "short_r",
           "drive": "Touchdown", "final": {"KC": 27, "NO": 23},
           "desc": "nflverse description of the real first snap"},
  "strength": {"KC": {"off_pass": 0.05, "off_rush": -0.02, "def_pass": -0.01, "def_rush": 0.03},
               "NO": {"off_pass": 0.0, "off_rush": 0.0, "def_pass": 0.0, "def_rush": 0.0}},
  "players": {
    "KC": {"off": [], "def": [], "k": {}, "p": {}, "subs": []},
    "NO": {"off": [], "def": [], "k": {}, "p": {}, "subs": []}
  }
}
```

* `spread`: points the **home** team is favored by (nflverse `spread_line`).
* `start.phase`: `snap` (normal), `kickoff` or `pat` if the spot opens on one.
* `strength`: team EPA per play relative to the league over the 17 games before this one
  (shrunk toward 0). `off_*` positive = better offense; `def_*` is EPA allowed, negative =
  better defense.
* each player object:
  `{"id": "00-0033873", "name": "Patrick Mahomes", "short": "P.Mahomes", "pos": "QB",
    "num": 15, "r": 92, "spd": 9.4}`
  * `r`: rating 40–99, the player's percentile at his position group from production in
    the 17 games before this one (see `pipeline/ratings.py`).
  * `spd`: top speed in yards per second (Next Gen Stats max speed where available,
    otherwise the position-group typical top speed).
* `off`/`def`: the 11 on the field for that team's offensive and defensive snaps in this
  game (the spot's own snap for the team with the ball when participation data exists).
  `subs`: up to 6 extra skill players (RB, WR, TE, FB) for personnel changes.

## `coaches.json`

```json
{
  "version": 1,
  "measures": ["pass", "deep", "go", "two"],
  "league": {"pass": {"mean": 0.0, "sd": 0.0}},
  "coaches": [{"name": "Andy Reid", "teams": ["KC"], "from": 2022, "to": 2026, "n": 523,
               "pass": 0.62, "deep": 0.14, "go": 0.35, "two": 0.2}]
}
```

Late-game play calling (fourth quarter with ≤ 5:00 left, or ≤ 2:00 before the half, score
within 16): `pass` share of called runs/passes that were passes; `deep` share of passes with
15+ air yards; `go` share of fourth-and-5-or-less in opponent territory where they went for
it; `two` share of touchdowns followed by a two-point try. `league` holds mean/sd of each
measure across coaches with at least 100 late-game snaps (for z-scores).

## `meta.json`

Build stamp, seasons covered, counts, sources and licenses, and whether the NGS API was
reached during the build.
