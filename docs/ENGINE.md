# Engine design and API

The engine is plain JavaScript (ES modules, no dependencies, no build step) under
`web/js/engine/`. It runs in the page, in module Web Workers, and in Node 22 (tests). It
reads only the files described in [`DATA.md`](DATA.md).

```
web/js/engine/
  rng.js       seeded PRNG (xoshiro128**), slot-addressed draws (Draws), hashes, UTC date helpers
  data.js      loading + indexing: call list, play pools, tilted-CDF cache, call/look mixes, kick tables, models
  rules.js     pure NFL rules: state transitions, clock, scoring, kicks, overtime; display text helpers
  resolve.js   one event (snap / try / kickoff) with a real play draw; team context; log narration
  policy.js    the "average NFL play-caller" for the opponent and for every simulated snap
  sim.js       Monte Carlo rest-of-game simulation with common random numbers
  grade.js     grade bands, daily percentile vs simulated coaches, typical caller, coach look-alike
  game.js      Game: the session object the UI talks to (decisions, grading, actions, summary)
  pool.js      worker pool that runs sim.js in module Web Workers (falls back to this thread)
  worker.js    Web Worker entry
  index.js     public exports (Engine, Game, GRADES, gradeOf, LOOKS, text and date helpers)
```

Tests: `node --test "tests/engine/*.test.js"` (Node 22 does not expand a bare directory
argument). Unit tests use a synthetic data set built in `tests/fixtures/synth.js`;
`tests/engine/integration.test.js` plays whole games on the real `web/data/` when it exists.
Benchmark: `node tests/engine/bench.mjs`.

## Game state

A plain, JSON-serializable object, never mutated in place (every transition returns a new
one). Teams are indices `0` (home) and `1` (away); `teams` holds abbreviations.

```js
{
  teams: ['NO', 'KC'], user: 1,       // the side the player coaches
  qtr: 4, clock: 118,                  // quarter (5+ = overtime periods), seconds left in it (fractional)
  score: [23, 20],
  pos: 1, down: 1, ytg: 10, yl: 75,    // team with the ball and its situation (DATA.md conventions)
  to: [3, 2],                          // timeouts left this half (or overtime)
  phase: 'snap',                       // 'snap' | 'pat' | 'kickoff' | 'done'
  running: false,                      // does the game clock run before the next snap?
  credit: 0,                           // seconds the clock was stopped after OOB/penalty outside the stop window
  kicker: null, free: false,           // phase 'kickoff': kicking team; free kick after a safety
  receive2h: 0,                        // team that receives the second-half kickoff
  warned: true,                        // two-minute warning already given in this half / overtime period
  ot: null,                            // overtime: {done: [n0, n1]} possessions each team has finished
  playoff: false, endAtHalf: false,    // endAtHalf: first-half spots end at halftime
  winner: null                         // 0, 1 or -1 (tie) once phase === 'done'; null at halftime of a first-half spot
}
```

`initialState(spot)` builds it from `spots/<id>.json`. For a spot that opens with
`phase: 'kickoff'` (none do today), `start.pos` is the kicking team; for `'pat'`, the trying team.

## Rules (rules.js)

* **Clock.** The game clock runs during every play. After the play it stops for an
  incompletion or spike; out of bounds or an accepted penalty **when the play ends** in the
  last 2:00 of the first half or the last 5:00 of the second half or of an overtime period
  (overtime counts as the second half); a score; a change of possession (turnover, downs,
  kicks); a timeout; the two-minute warning; the end of a quarter. Out of bounds outside the
  window keeps the clock running with a 4 s restart credit, an accepted penalty with 20 s
  (the credit is subtracted from the next runoff). There is no 10-second runoff rule.
* **Runoff before the snap** (clock running): drawn from `special.between[tempo]` (19
  percentiles, linear between them and extrapolated to the tails, clipped to 1–40 s, the play
  clock). Tempos: `hurry`, `normal`, `milk` (`special.between.kill`). A kneel with `milk` takes
  38–40 s, a spike 5–12 s, a rushed field goal 7–12 s. A team that is not ahead in the second
  half never lets the runoff expire the clock before its snap (1 s kept, any tempo); the
  policy's kick-to-win milk keeps 12 s.
* **Two-minute warning** (Q2, Q4, regular-season overtime, even playoff overtime periods):
  if the runoff would cross 2:00 the clock stops at 2:00 and the snap is from a stopped
  clock; a play that crosses 2:00 completes and the clock stops after it.
* **Timeouts**: 3 per team per half; overtime 2 (regular season) or 3 (playoffs, reset at the
  start of the 3rd, 5th... period). A timeout called with the clock running costs one second
  of reaction (never past the two-minute warning). Either team may call one before a snap.
* **Spike**: an incompletion that uses a down, 2 s (`special.dur.spike`). **Kneel**: −1 yard
  (never into the end zone), `special.dur.kneel` seconds, the clock keeps running.
* **Burn the clock**: a leading offense with ≤ 8 s left in the half holds the ball until time
  expires (play duration ≥ time left + 0.5 s) unless the play stops the clock by itself.
* **Quarters**: a play that starts with time left is completed. End of Q1/Q3: same
  possession, clock stopped. End of Q2: halftime (kickoff by the team that does not receive
  the second half, timeouts reset) or, for a first-half spot, the end of the game
  (`winner: null`). End of Q4: game over unless tied → overtime. The half cannot end on an
  accepted defensive foul: an **untimed down** follows (also after roughing the kicker).
* **Overtime** (2025 rules): 10:00 regular season / 15:00 playoffs; coin toss at random, the
  winner receives; both teams get a possession unless the first one ends with a safety or a
  defensive touchdown; once both teams have finished a possession, any difference in score
  ends the game (a touchdown that puts the scoring team ahead after the other team has had
  the ball ends it without a try). A regular-season game tied after the period is a tie;
  playoff overtime continues with new periods.
* **Scoring**: TD 6 then a try (XP from the 15 at `special.xp.rate`, shifted by the kicker
  rating; two-point try from the 2 with a real play, see below), FG 3, safety 2 then a free
  kick by the conceding team. No try after a touchdown on the last play of regulation unless
  the margin after the touchdown is −2..0. Defensive two-point returns are not modelled.
* **Kickoffs**: rows of `special.kickoff` drawn uniformly (touchback at the 35 is in the
  data); returned kicks take 5–7 s, touchbacks 0. A free kick after a safety starts the
  receiver 10 yards better (clipped to its 25..60). **Onside** kicks only by a team trailing
  in the 4th quarter or overtime (never free kicks): recovered with `special.onside.rate`
  (at least 4%), kicking team at `yl` 54, otherwise receiving team at `yl` 46; 3 s.
* **Punts**: a punt drawn from those within ±5 yards of the line (widening by 5 until 30
  rows), its receiving spot shifted by the difference in line of scrimmage, plus the punter
  rating (0.05 yd per rating point from 70); touchbacks at the 20, return TDs, muffs
  recovered by the kicking team, blocks from the data. 5.5 s if downed/fair caught/touchback,
  9 s returned, 12 s return TD.
* **Field goals**: `special.fg` logistic on `dist = yl + 18`, indoor and wind, plus the
  kicker rating (0.004 logit per rating point from 70). The fit flattens past 60 yards, so
  the logit tapers by 0.12 per yard past 56 and the chance fades to 0 between 66 and 70
  yards. A rushed kick ("fire drill": clock running, no timeout, and `hurry` tempo or ≤ 25 s
  left in the half) loses 7–12 s before the snap and 0.3 on the logit. Blocked kicks:
  `special.fg.blocked` of attempts; 10% of blocks are returned for a touchdown. A miss
  gives the ball to the defense at the spot of the kick (`yl + 7`), or its 20. 5 s.
* **Turnover on downs** at the spot.

## Resolving a snap (resolve.js, data.js)

1. Offense timeout (if asked and the clock runs), then the runoff (above). If the half or
   game ends before the snap, nothing else happens (`log` type `expired`).
2. Situation key: `mode` (DATA.md) × down bucket × distance bucket × field zone (252 keys).
3. Pool for (call, key). With fewer than 40 plays it widens: any mode → neighbouring
   distances → any down → neighbouring zones → any distance → zones ±2 → the whole call.
   If the defense's look is known (the look shown to the player on offense, or the player's
   defensive call), the pool is restricted to plays against that look, widened the same way
   until it has 40 such plays (else the unrestricted pool). Two-point tries draw from the
   call's two-point plays, widened with goal-to-go snaps inside the 3, then the 5.
   **Dropback pressure.** The pipeline labels a pass by where the ball was thrown, so every
   sack and scramble (no throw, no location) of a straight dropback is filed under
   `short_m`, and of a play-action pass under `pa_short`: in the real data `short_m` is 39%
   sacks and scrambles while `deep_*`, `short_l/r` and `pa_deep` have none. The engine
   therefore moves those plays into one *pressure pool* per family (dropback: `short_*`,
   `deep_*`; play action: `pa_short`, `pa_deep`) and situation; a snap of any call of the
   family is drawn from the pressure pool with the family's real pressure rate in that
   situation (widened like the call mixes), and from the call's own plays otherwise (same for
   two-point tries). The NFL call mix shares each pressure snap out over the family's calls in
   proportion to their other plays, and the per-call numbers shown to the player include it.
4. Weight each play `w = exp(k · epa)` (×3 for plays that ended out of bounds when the
   offense tries to get out), `k = τm·s/σ + Δ/σ²`:
   * `σ` is the pool's EPA standard deviation (floor 0.3), `τm = 0.25`,
   * `s` is the **matchup** of the call against the look (raw table in `resolve.js`: blitzes
     are beaten by quick throws and screens, loaded boxes by play action and deep shots,
     light boxes by runs; the reverse loses), **centred** on the situation's look mix:
     `s = raw(call, look) − Σ_L P(L | situation) raw(call, L)`, clipped to ±1.5. Light boxes
     are over half of all real snaps, so an uncentred table would make runs better and deep
     passes worse than the data on average; centred, every call keeps its real average and
     reading the look pays. No look (simulated snaps after the first): `s = 0`.
   * `Δ` is **team strength** for the offense's call kind: `off_pass|off_rush` of the
     offense plus `def_pass|def_rush` of the defense (spot `strength`), plus 0.0008 × the
     gap between the offense's and the defense's weighted player ratings (pass: QB 40%,
     receivers 35%, line 25% vs secondary 60%, front 40%; run: back 40%, line 60% vs front
     70%, secondary 30%), capped at ±0.15 EPA.
   Weighted CDFs are cached per (pool, k rounded to 1/4096, oob), so a draw is one binary
   search.
5. Apply the play at the current spot: a real touchdown drawn from farther out scores only
   if its yards cover 60% of the new distance (else it is tackled after its real yards); a
   long gain that reaches the end zone scores; penalty yardage never scores (a wiped-out
   play's foul is capped at half the distance, 15+ yard fouls at the 1); a fumble that now
   happens past the goal line is a touchdown; turnovers give the defense the ball at
   `100 − yl + tov` (≤ 0 or return-TD flag: defensive touchdown; ≥ 100: touchback); a loss
   past the goal line is a safety. Penalties replay the down unless they gain the line or
   give an automatic first down.
6. Defense on kicks: a block attempt multiplies the block chance by 4 and draws a roughing /
   running-into-the-kicker flag 4% of the time (punt: 15 yards and a first down; field goal:
   15 yards and a first down unless the kick was good); a rushed punt is not returned (+4
   net yards).

## The computer play-caller (policy.js)

Used for the opponent and for every simulated snap, for both teams.

* **Calls**: sampled from the NFL call mix of the situation key (play counts, widened to 150
  plays keeping the mode as long as possible). Never the Hail Mary from the mix. Against a
  defensive call the player chose, the offense "checks into" calls that beat it: weights
  × `exp(0.5 · s)`.
* **Tempo**: second half: hurry when trailing with ≤ 5:00, down 9+ with ≤ 10:00, or tied
  with ≤ 1:15 not backed up; milk when leading with ≤ 10:00, tied with ≤ 4:00, or setting
  up a kick to win. First half (≤ 2:00): hurry if it can reach field-goal range
  (`yl − 35 ≤ 0.6 × (secs + 20 × timeouts)`), else milk.
* **Kneel** when leading (or tied and backed up with ≤ 0:40) and `canKneelOut`: kneels left
  before 4th down at 1.5 s, ~39 s per running gap, each defensive timeout or a pending
  two-minute warning stopping one gap. First half: kneels to run out the half when not
  attempting to score.
* **Timeouts**: offense, second half, not ahead with ≤ 1:00 (or down 9+ with ≤ 2:00), or
  in field-goal range with ≤ 0:25 when a kick ties or wins; first half when attempting and
  short of time. Defense: trailing with ≤ 4:00 (≤ 7:00 when down 9+), or protecting a 0–2
  point lead/tie against an offense in field-goal range with ≤ 2:00 — never when the
  offense can kneel it out; first half when the offense is running out the clock.
* **Spike**: clock running, no timeouts, down ≤ 3, hurrying with ≤ 0:35 (or in range for
  a tying/winning kick with ≤ 0:22).
* **Last play / kicks**: with ≤ 6 s a useful field goal (first half, or a margin −3..0) is
  kicked if makeable (≥ 8%); with the clock stopped and ≤ 8 s (15 s without timeouts) at
  ≥ 30%. **Kick to win**: down 0–2 with ≤ 3:00, a timeout and ≥ 50% from here: milk with
  safe runs, then with ≤ 0:45 run the clock down to 0:03, call the timeout and kick.
  Fire drill on 4th down with ≤ 0:25. Hail Mary with ≤ 10 s beyond the 40 when a
  touchdown is needed.
* **Fourth down**: forced choices first (overtime after the other team's possession;
  ≤ 0:40 left: go when a field goal does not help, kick when it ties or wins and is ≥ 30%;
  Q4 down 4+ with ≤ 2:30 or down 9+ with ≤ 5:00: go; tied and out of range in own half
  late: punt; first half ≤ 0:20: kick at ≥ 20%), otherwise the `special.fourth`
  multinomial model with the exact features of `pipeline/models.py` (no punts inside the
  30, no kicks below 2%).
* **Tries**: two-point rate from `special.go2` by the margin after the touchdown (`late` in
  the last 5:00 and overtime); down 2 or 5 late always goes for two; a tie at 0:00 kicks.
  The two-point call is sampled from the real two-point call mix.
* **Kickoffs**: onside (when legal, never on free kicks) with ≤ 2:05 left and ≤ 1 timeout,
  ≤ 1:05 left, or down 9+ with ≤ 2:40.

## Simulation (sim.js)

* `evaluate(lib, ctx, state, options, {n, seed})` returns the user's average result after
  each option: the option is the first event, then the policy plays the rest of the game for
  both teams (hard cap: 400 events). Win 1, tie 0.5, loss 0; a first-half spot ends at
  halftime and scores `special.halftime_wp` for the user (margin, receives the second half,
  point spread).
* **Common random numbers**: every uniform is addressed by (seed, run, event, slot), where
  the slot names its purpose (`SLOT` in rng.js: runoff, call, fourth down, play draw, pick,
  roughing, try, coin toss, two-point call, look, pressure). Two options compared with the same seed
  see the same random futures, and the same real play is drawn for the same purpose even if
  one option skips a draw (e.g. a timeout instead of a runoff). Splitting work across workers
  by option or by run gives identical numbers.
* Performance (Node 22, one core, real data): 40 options × 400 runs of a two-minute drill
  (2:30 left) ≈ 0.5 s (≈ 30 µs per simulated game); ≈ 0.3 s for a 1:45 drill; ≈ 1.6 s from
  15:00 left in the 4th. Data load ≈ 0.1 s plus the download. A first decision's prefetch
  takes ≈ 0.4 s in one thread; `act()` after a prefetch ≈ 0.1 s.
* Calibration: the policy-vs-policy win chance of each real second-half spot (200 runs)
  against what actually happened, over all 984 such spots: two-minute drills 25% predicted
  vs 27% won, protect-the-lead 89% vs 89%, 4th-quarter spots 38% vs 37%, tied 63% vs 61%.

## Grading (game.js, grade.js)

* **Options graded** at each decision:
  * offense: every call (trick plays only if the chosen call is one; the Hail Mary only when
    offered; the QB sneak only with ≤ 3 to go) under the default clock settings and under the
    player's settings, the specials offered (spike, kneel, field goal, run it down and kick,
    punt), and for the three best calls/specials of round 1 every clock variant: each tempo
    and a timeout when the clock runs, × "get out of bounds" in the stop window;
  * defense: the 4 looks (only `base` against a kneel or spike), × timeout when available;
  * try: the extra point and a two-point try with each call (trick plays only if chosen);
  * kickoff: deep vs onside; kick defense: stay home vs block, × timeout when available.
* **Two rounds**: round 1 runs every option `n = 500` times on one seed; round 2 re-runs the
  three best of round 1 and the player's choice `n = 6000` times on a fresh seed (avoiding the
  winner's curse). Options not re-run count as `min(round-1 value, best round-2 value)`.
  `prefetch()` runs round 1 for the default settings and round 2 for the leaders while the
  player thinks; `act()` adds the player's settings and choice.
* **Grade** = best option's win chance − the chosen option's, in percentage points:
  ≤ 0.5 green ✓ (best), ≤ 2 yellow ≈ (close), ≤ 5 orange ! (costly), else red ✗ (big miss).
* **NFL frequency** of each option (`freq`, normalised over the graded options): calls by
  P(call | situation) × P(look | call); clock variants: the usual tempo 0.8, a timeout 0.14
  (0.03 when leading late), other tempos 0.03, "get out of bounds" twins 0; 4th down: the
  `special.fourth` model splits go / FG / punt; field goals before 4th down 0.6 with ≤ 10 s,
  0.2 with ≤ 20 s or on 3rd down with ≤ 40 s, else 0.02 (run-it-down 0.6); kneel 0.5 when
  leading else 0.1; spike 0.06; looks by the situation's look mix × timeout 0.15/0.85;
  tries by `special.go2` × the two-point call mix; onside 0.8 when the policy would, else
  0.03; kick defense block 0.2 / safe 0.8 × timeout 0.1/0.9.
* **Typical NFL play-caller** at a decision: the frequency-weighted win chance; the summary
  reports its total loss and the player's total gain over it (`typical.wpa`).
* **Daily percentile**: 4,000 simulated coaches over the same decisions. 15% call by NFL
  frequency only; the others pick option `i` with probability ∝ `freq_i · exp(β (wp_i −
  best))` with `β = 1/τ`, τ log-uniform on [0.003, 0.3] (stratified, so results are smooth
  and repeatable). Each coach samples one option per decision (seeded by the game seed); the
  percentile is the share of coaches who lost more win chance than the player (ties count
  half). Losses within the green band (≤ 0.5 points) count as zero for the player and the
  coaches alike: the coaches choose with the exact simulated values, so without this the
  Monte Carlo noise between near-equal options would cost a perfect player percentiles. It
  falls monotonically as the player's loss grows.
* **Coach look-alike**: four measures, each a sum over decisions of the player's choice (1/0)
  and of what NFL play-callers would have done in the same spots (`freq`-weighted):
  `pass` (pass calls among play calls), `deep` (deep calls among pass calls), `go` (plays
  among 4th-and-≤5 decisions in opponent territory, `yl < 50`), `two` (two-point tries
  among tries). z = `(mine − exp) / (n + 1) / league sd`; each coach's z = `(rate − mean) /
  sd` from `coaches.json`; distance = Σ `n/(n+1) · (z − z_coach)²` over measures with data;
  nearest coach with at least 100 late-game snaps wins, with up to two reasons. Totals add across days (`addMeasures`).

## Public API (index.js)

```js
import { Engine, GRADES, gradeOf, LOOKS, clockText, downText, ballText, utcDate, addDays, dayIndex }
  from './engine/index.js';

const eng = await Engine.load('data/', { fetchJson, workers });
// fetchJson(url) => Promise<json> (default: fetch); workers: pool size (default min(3, cores-1),
// 2 on touch devices; 0 = evaluate in this thread). Workers start loading while this thread loads.
eng.spotIndex                       // spots/index.json
eng.calls                           // calls.json calls (26)
eng.dailySpotId(date = utcDate())   // 'YYYY-MM-DD' (UTC) -> daily[(days since launch) mod len], wraps both ways
eng.survivorSpotIds()               // spots/index.json survivor
await eng.loadSpot(id)              // spots/<id>.json (cached)
const game = eng.newGame(spot, { mode: 'daily' | 'survivor', seed, tendencies, runs });
// seed: default derived from the spot id (same draws for every daily player making the same
// choices); random in survivor. tendencies: the player's recent call ids (persist game.tend
// across games: the defense adapts its looks to them). runs: {r1: 500, r2: 6000, after: 600}.
await Engine.restore(eng, game.toJSON(), spot?)   // resume a saved game (fetches the spot if omitted)
eng.emptyMeasures(), eng.addMeasures(a, b), eng.lookalike(measures)   // look-alike across days
eng.close()                         // stop the workers
```

### Game

```js
game.state            // GameState (current)
game.seq              // decision counter
game.over             // phase === 'done'
game.tend             // recent call ids (persist and pass back as `tendencies`)
game.history          // one entry per act() (see below)
game.decision()       // the current Decision (cached until act())
game.prefetch(d?, settings?)  // Promise<void>: start grading d (settings: {tempo, timeout, oob})
await game.act(action)        // {log, grade, wpBefore, wpAfter, state}
await game.winChance()        // the user's win chance now (policy for both teams)
game.summary()                // Summary
game.toJSON()                 // {v: 1, spotId, mode, seed, seq, state, history, tend, runs}
```

`act()` grades the choice (awaiting any prefetch), resolves it with a real play, then plays
automatic follow-ups (the opponent's defensive timeout before the user's next snap). It
throws for an action that does not fit the decision, after the game is over, and while
another `act()` is still running (double clicks). Opponent offensive snaps are resolved
when the user picks a defensive call; the opponent's kickoffs and tries are `auto` decisions
(the user's own kickoff too unless an onside kick is legal); the opponent's punts and field
goals are `kick_defense` decisions.

### Decision

Every decision:

```js
{
  seq: 7,
  kind: 'offense' | 'defense' | 'pat' | 'kickoff' | 'kick_defense' | 'auto' | 'done',
  team: 1,                    // the user's team index (auto: the acting team; done: null)
  prompt: 'Your call',        // short heading ('Your defense', "They're punting", 'NO kick off', ...)
  state,                      // GameState
  situation: {
    qtr, clock, clockText: 'Q4 1:58', halfSeconds, running, phase,
    possession: 'user' | 'opp', offense: 'KC',
    down, ytg, yl, downText: '3rd & 4' | '1st & Goal' | 'Try' | 'Kickoff' | 'Free kick',
    ballText: 'KC 25', userView: 'own 25' | 'opp 35' | '50',
    score: {user, opp}, margin, timeouts: {user, opp},
  },
  look: null,                 // offense: the defense's look ('base' | 'blitz' | 'load' | 'soft')
  options: [ ... ],           // menu entries, below
}
```

Kind-specific fields:

* `offense`: `look`, `lookIndex` (0..3), `lookText` ('Base defense' | 'Showing blitz' |
  'Loaded box' | 'Light box'), `lookOdds` / `lookBase` (4 probabilities: adapted to the
  player's habits / NFL), `tempo: {default, choices: ['hurry', 'normal', 'milk']}` or null
  when the clock is stopped, `timeout: {available, left}`, `oob: {available}` (the stop
  window: getting out of bounds matters), `defaults: {tempo, timeout: false, oob: false}`.
  Options:
  ```js
  { id: 'short_r', type: 'play', call: 'short_r', label: 'Short pass right', family: 'pass',
    kind: 'pass', dir: 'right', depth: 'short',
    nfl: { freq, avg, conv, inc, oob, td, tov, n } }   // NFL share of this call here; average
    // gain, conversion / incompletion / out-of-bounds / TD / turnover rates of the call's real
    // plays applied at this spot; n plays
  { id: 'spike', type: 'spike', label: 'Spike the ball' }          // clock running, down <= 3, need time, <= 3:00
  { id: 'kneel', type: 'kneel', label: 'Kneel' }                   // when it makes sense (never 4th down)
  { id: 'fg', type: 'fg', label: 'Field goal (38 yards)', fg: { dist, p, rushed } }  // rushed: p if forced to hurry
  { id: 'rundown', type: 'fg', rundown: true, label: 'Run it down, timeout at 0:03, kick', fg }
  { id: 'punt', type: 'punt', label: 'Punt' }                      // 4th down, yl >= 30
  ```
  The Hail Mary is listed only with ≤ 0:30 left in the half and `yl ≥ 30`; the QB sneak only
  with ≤ 3 to go; the field goal per the original's rules (4th down ≥ 5%; ≤ 0:20 ≥ 20%; 3rd
  down ≤ 0:40 ≥ 40%; last 2:00 / 5:00 ≥ 30%; not kickable with < 7 s running and no timeout).
* `defense`: `offense: 'play' | 'kneel' | 'spike'` (what the opponent lines up to do),
  `timeout: {available, left}`, `defaults: {timeout: false}`. Options
  `{ id: 'blitz', type: 'defense', look: 'blitz', label: 'Blitz', nfl: { freq } }` for
  base/blitz/load/soft ('Base defense', 'Blitz', 'Load the box', 'Play it soft'); only `base`
  when the opponent kneels or spikes.
* `kick_defense`: `kick: 'fg' | 'punt'`, `fg: {dist, p}` or null, `timeout`, `defaults`.
  Options `{ id: 'safe', type: 'kick_defense', block: false, label: 'Stay home' | 'Set up the
  return' }`, `{ id: 'block', ..., block: true, label: 'Go for the block' | 'Rush the punt' }`.
* `pat`: options `{ id: 'xp', type: 'pat', kind: 'xp', label, p }` and, per call (not the Hail
  Mary), `{ id: 'two:short_m', type: 'pat', kind: 'two', call: 'short_m', label: 'Go for two:
  Short pass middle', family, nfl: { freq, conv, n } }`.
* `kickoff` (only when the user may onside kick): `{ id: 'deep', type: 'kickoff', onside:
  false, label: 'Kick it deep' }`, `{ id: 'onside', ..., onside: true, label: 'Onside kick', p }`.
* `auto`: `auto: { event: 'pat' | 'kickoff' | 'kneel' | 'spike', team, text }`, options
  `[{ id: 'auto', type: 'auto', label: 'Continue' }]`.
* `done`: no options.

### Actions

A menu entry merged with the clock settings is a valid action
(`game.act({ ...option, tempo, timeout, oob })`). Explicitly:

```js
{ type: 'play', call: 'short_r', tempo: 'hurry', timeout: false, oob: false }
{ type: 'spike' }
{ type: 'kneel', tempo: 'milk', timeout: false }
{ type: 'fg', tempo, timeout: false }        // tempo 'hurry' (or <= 0:25 running, no timeout) = rushed kick
{ type: 'fg', rundown: true }                // run the clock to 0:03, timeout, kick
{ type: 'punt', tempo, timeout: false }
{ type: 'defense', look: 'blitz', timeout: false }       // look: base | blitz | load | soft
{ type: 'kick_defense', block: true, timeout: false }    // the opponent's FG or punt
{ type: 'pat', kind: 'xp' }  { type: 'pat', kind: 'two', call: 'short_m' }
{ type: 'kickoff', onside: false }
{ type: 'auto' }                                          // or act() with no argument
```

`tempo` only matters while the clock runs (default: the decision's `defaults.tempo`);
`timeout` is ignored unless the clock runs and a timeout is left; `oob` only applies in the
stop window. Irrelevant settings are normalised away, so equivalent actions grade identically.

### act() result

```js
{
  log: [LogEntry],            // this action's events in order (the play, then e.g. the opponent's timeout)
  grade: Grade | null,        // null for auto events
  wpBefore: 0.43,             // win chance of the chosen option (auto: of the state before)
  wpAfter: 0.51,              // win chance after the play (600 simulations; the result when the game is over)
  state,                      // new GameState (also game.state)
}
```

`Grade`:

```js
{
  chosen: 0.43, best: 0.47, delta: 4.0,          // win chances 0..1; delta in percentage points
  symbol: '!', color: 'orange', word: 'costly',   // GRADES band
  chosenKey, chosenLabel, bestKey, bestLabel, bestAction,
  typical: 0.44,                                  // NFL-frequency-weighted win chance here
  options: [{ key: 'play:short_r:hurry', label: 'Short pass right, no-huddle', action, wp, n, freq,
              chosen: false, best: true }]        // every graded option, best first
}
```

`LogEntry` (all types): `{ type, team, text, headline, qtr, clockBefore, clockAfter,
qtrAfter, pre, post, score, state }` where `type` is `play`, `kneel`, `spike`, `fg`,
`punt`, `kickoff`, `xp`, `two`, `timeout` or `expired` (time ran out before the snap);
`text` is the play-by-play line with the spot's player names; `headline` a short result
("+8 yards", "Sacked, -7", "Touchdown!", "Intercepted", "Field goal is good", "Punt, net 41",
"Touchback", "Onside kick recovered!", ...); `pre` the events before the snap
(`{type: 'timeout' | 'runoff', team, secs, stop: '2mw' | 'period' | null, clock, qtr, why,
text}`, text empty for runoffs under 3 s); `post` notes after the play ('Two-minute
warning', 'End of the quarter', 'Halftime', 'End of regulation: overtime', 'Final', ...);
`score` whether the score changed; `state` the state after the event. By type:

* `play`: `call`, `callLabel`, `look` (the defense's look or null), `matchup` (the centred
  matchup score), `yards`, `first`, `turnover`, `flags` (plays.json bits), `real: {gameId,
  pid, season, week, away, home}` (the real snap), `players: {passer, target, carrier,
  defender}` (each `{id, name, short, pos, num, r}` or null), and `anim: {kind: 'pass' |
  'run' | 'sack' | 'scramble' | 'penalty', fromYl, toYl, yards, air, loc: 'left' | 'middle'
  | 'right', carrierPos: 'QB' | 'RB' | 'WR' | 'TE' | 'OTHER', complete, inc, oob, td, int,
  fumble, defTd, penalty, dur}` (yard lines from the offense's point of view at the snap).
* `kneel`, `spike`: `anim: {kind, fromYl, toYl, yards}`.
* `fg`: `fg: {dist, p, made, blocked, roughing, retTd, fire}`, `players.kicker`,
  `anim: {kind: 'fg', fromYl, dist, made, blocked}`.
* `punt`: `punt: {recvYl, retTd, kickRec, blocked, roughing, touchback, net}`,
  `players.punter`, `anim: {kind: 'punt', fromYl, recvYl, net}`.
* `kickoff`: `kick: {onside, recovered, retTd, recvYl, touchback, free}`,
  `anim: {kind: 'kickoff' | 'onside', recvYl}`.
* `xp`: `anim: {kind: 'xp', made}`; `two`: `call`, `real`, `anim: {kind: 'pass' | 'run', made}`.

### History entries and summary

`game.history[i]`: `{ seq, kind, prompt, situation, look, action, choice: {key, label} |
null, grade, pct: {wp, q, best, chosen} (percentile inputs), measures, log (entries without state),
wpBefore, wpAfter, before: {score, qtr, clock} }`.

`game.summary()`:

```js
{
  over, mode, spotId,
  result: 'win' | 'loss' | 'tie' | 'half' | 'playing', won, alive (survivor: not a loss; else null),
  overtime, score: {user, opp}, teams: {user, opp},
  winChance,                       // final result (1/0.5/0), halftime win chance for first-half spots
  decisions: [{seq, kind, situation, chosen, best, delta, symbol, color, wpBefore, wpAfter}],
  squares: ['green', 'orange', ...], counts: {green, yellow, orange, red},
  cost: 6.3,                       // total win chance lost (points)
  typical: { cost, wpa },          // a typical NFL play-caller's loss; your gain over it (points)
  percentile: 72.5 | null,         // 0..100 vs 4,000 simulated coaches (null: nothing graded)
  measures: {pass: {n, mine, exp}, deep, go, two},   // add to stored totals with eng.addMeasures
  lookalike: { coach, distance, z, reasons: [{measure, z, weight, text}] } | null,
  real: { coach, call, callLabel, drive, final: {user, opp}, desc,
          verdict: 'better' | 'worse' | 'same' | null, mine, theirs },
}
```

`real.verdict` compares the sign of the final margin with the real one for Q4 spots, and the
net points scored before halftime with the real drive's value (TD 7, FG 3, opponent TD −7,
safety −2) for first-half spots.

## Workers (pool.js, worker.js)

`EvalPool.evaluate(ctx, state, options, {n, seed})` → `Promise<Float64Array>` of means. The
pool splits the work into about two jobs per worker, by option when there are many, by run
ranges otherwise; results are identical to in-thread evaluation. Protocol: `{type: 'init',
baseUrl}` → `{type: 'ready'}` | `{type: 'error'}`; `{type: 'eval', id, ctx, state, options,
n, seed, start}` → `{type: 'result', id, sums}` (transferred). Workers that fail are dropped
and their jobs requeued; with none left, evaluation runs in this thread (yielding to the UI
between options in browsers).

## Differences from the original game

This is an independent implementation; where the original's behaviour (described in a
clean-room spec) differed or was a quirk, this engine chose:

* One graded decision per snap (calls × clock settings), not separate clock and call
  decisions; the try is one decision (extra point or two-point by call).
* The overtime coin-toss winner always receives; free kicks after a safety are automatic.
* No receiver/route picking and no personnel groupings (not in the data contract).
* Simulated snaps use the call-level library with the policy's call mix (no separate
  kind-level library) and no matchup (only the first, decided snap has a look).
* The matchup table is centred per situation (above) to keep the real data's averages.
