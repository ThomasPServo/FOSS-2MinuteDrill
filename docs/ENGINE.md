# Engine design and API

The engine is plain JavaScript (ES modules, no build step) under `web/js/engine/`. It runs
in the page, in Web Workers, and in Node (for tests). It reads only the files described in
[`DATA.md`](DATA.md).

```
web/js/engine/
  rng.js       seeded PRNG (xoshiro128**), string hashing, date helpers
  data.js      loading + indexing: call list, play library pools, CDF cache, models
  rules.js     pure NFL rules: game state transitions, clock, scoring, kicks, overtime
  resolve.js   turns an action into a real play draw and applies it (one snap / kick / try)
  policy.js    the "NFL play-caller" used for the computer side and for simulations
  sim.js       Monte Carlo rest-of-game simulation and option evaluation
  grade.js     grades, daily percentile against simulated coaches, coach lookalike
  game.js      Game: the session object the UI talks to (decisions, actions, history)
  pool.js      worker pool that runs sim.js in Web Workers (falls back to main thread)
  worker.js    Web Worker entry
  index.js     public exports
```

## Game state

A plain, JSON-serializable object (so it can be saved to `localStorage` and posted to
workers). Teams are indices `0` (home) and `1` (away); `teams` holds abbreviations.

```js
{
  teams: ['NO', 'KC'], user: 1,            // the side the player coaches
  qtr: 4, clock: 118,                       // quarter (5 = overtime) and seconds left in it
  score: [23, 20],
  pos: 1, down: 1, ytg: 10, yl: 75,         // team with the ball and its situation (DATA.md conventions)
  to: [3, 2],                               // timeouts left this half
  phase: 'snap',                            // 'snap' | 'pat' | 'kickoff' | 'done'
  running: false,                           // will the game clock run before the next snap?
  kicker: null,                             // phase 'kickoff': team that kicks
  receive2h: 0,                             // team that receives the second-half kickoff
  warned: [false, false],                   // two-minute warning given (first half, second half)
  ot: null,                                 // overtime bookkeeping {poss: [n0, n1], first, sudden}
  playoff: false, endAtHalf: false,         // endAtHalf: first-half spots end at halftime
  winner: null                              // 0, 1, or -1 (tie) once phase === 'done'
}
```

## Rules implemented (rules.js)

* **Clock.** The game clock runs during every play. After the play it stops for: an
  incompletion; out of bounds in the last 2:00 of the first half or the last 5:00 of the
  second half (and all of overtime); a score; a change of possession; a timeout; the
  two-minute warning; the end of a quarter; an accepted penalty in the last 2:00/5:00.
  Otherwise it keeps running and the time between plays runs off (by tempo, from
  `special.between`), capped by the 40-second play clock.
* **Two-minute warning**: when the clock crosses 2:00 in the 2nd or 4th quarter, it stops at
  2:00 after the play (or before the snap, if the runoff would cross it).
* **Timeouts**: 3 per team per half, 2 per team in a regular-season overtime. Calling one
  before a snap stops the clock (no runoff before the snap). The defense may call one too.
* **Spike**: an incomplete pass that uses a down and about 1 second; the clock stops.
* **Kneel**: −1 yard (never into the end zone), about 1 second; the clock keeps running.
* **Quarters**: a play that starts with time left is completed. End of Q1/Q3 changes
  nothing else; end of Q2 is halftime (second-half kickoff to `receive2h`, timeouts reset);
  end of Q4 ends the game unless tied, which goes to overtime.
* **Overtime** (2025 rules, regular season and playoffs): 10:00 regular season / 15:00
  periods in the playoffs; coin toss (random); both teams get a possession unless the first
  one ends with a safety or a defensive score; after both have had it, the next score
  wins. A regular-season game tied after the overtime period is a tie.
* **Scoring**: TD 6 then a try (XP from the 15, or a two-point try from the 2), FG 3, safety 2
  (then a free kick, treated as a kickoff from the 20 with the receiver starting about 10
  yards better than a normal kickoff). Defensive two-point returns are not modelled.
* **Kickoffs** (2025 rule): draws from `special.kickoff` (touchback to the 35). Onside kicks
  only by a team trailing in the 4th quarter or overtime; success rate `special.onside.rate`;
  a recovered onside kick gives the kicking team the ball around the receiving team's 47
  (yl 53 from its own perspective... i.e. kicking team at `yl` ≈ 53).
* **Punts**: draws from `special.punt` with a similar `yl` (±5 yards, widening if needed).
* **Field goals**: `special.fg` logistic by distance (`yl + 18`), indoor and wind. A rushed
  kick with the clock running and no timeout (a "fire drill") costs 8–12 seconds and is a
  little less accurate (logit −0.3). Missed: the other team takes over at the spot of the
  kick (`yl + 7`), or its own 20 if that is inside the 20.
* **Turnover on downs** at the spot when a fourth-down play falls short.

## Resolving a snap (resolve.js, data.js)

1. Build the situation key: `mode` (DATA.md), down bucket, distance bucket, field zone.
2. Find the play pool for (call, key). If it has fewer than 40 plays, widen in this order:
   ignore mode → merge neighbouring distance buckets → merge down → neighbouring zones →
   the whole call. Two-point tries use the call's two-point plays, widened with goal-to-go
   snaps inside the 3.
3. Weight each play `w = exp(k · epa)`, with `k = (τm · s) / σ + Δ / σ²`:
   * `s` ∈ [−1, 1] is the **matchup** of the call against the defense's look (table in
     `resolve.js`: blitz is beaten by quick throws and screens, a loaded box by play action
     and deep shots, a light box by runs; the reverse loses), `τm = 0.25`,
   * `σ` is the pool's EPA standard deviation,
   * `Δ` is **team strength**: offense's `off_pass`/`off_rush` plus defense's
     `def_pass`/`def_rush` from the spot, plus a small player-rating term (offense skill
     players and line against the defense's front and secondary), capped at ±0.15 EPA.
   * "Get out of bounds" multiplies the weight of plays that ended out of bounds by 3.
   Weighted CDFs are cached per (pool, k) so a draw is a binary search.
4. Apply the play at the current spot: yards, touchdown/safety, first down, turnover (via
   `tov`), penalty (repeat the down unless an automatic first down), clock (`dur` plus the
   stoppage rules above). A real touchdown drawn from farther out than it happened scores
   only if it covered at least 60% of the new distance; otherwise it is tackled after its
   real yardage.
5. Return a log entry: the call, the real play reference (`games[g]`, `pid`), yards,
   result text, players involved (from the spot's lineups by position group: passer, target
   or ball carrier, tackler/defender), the clock before and after, and the new state.

## The computer play-caller (policy.js)

Used for the opponent and for every simulated snap. It behaves like an average NFL
play-caller:

* **Calls**: sampled from the NFL call mix for the situation key (play counts in the
  library). Hail Mary only with ≤ 10 seconds in the half and `yl > 40`.
* **Tempo**: hurry in `mode` hurry, milk in `mode` kill, otherwise normal.
* **Timeouts**: the offense in hurry mode with the clock running and under 1:30 left in the
  half calls one; the defense trailing (or tied) in the 4th quarter calls one when the
  clock is running and the time left exceeds what the offense could kneel out.
* **Kneel**: when leading and the remaining time can be run out by kneeling given the
  defense's timeouts; also to end the first half when backed up.
* **Spike**: hurry, clock running, no timeouts, under 0:25, after a gain in bounds.
* **Fourth down**: forced choices first (trailing late and a field goal doesn't help → go;
  a field goal that wins or ties as time expires → kick), otherwise the `special.fourth`
  model.
* **Kick-to-win**: trailing by 1–2 or tied late with a likely field goal and a timeout,
  run the clock down with safe runs, take the timeout with ~3 s left and kick.
* **Tries**: the `special.go2` table, with chart overrides late in the game.
* **Kickoffs**: onside when trailing with under ~2:30 left and needing the ball back.

## Simulation and grading (sim.js, grade.js)

* `evaluate(state, options, {n, seed})` returns the user's win chance after each option:
  for each of `n` runs the option is applied and the rest of the game is played by the
  policy for both teams. Every option uses the same random stream for run `i` (common random
  numbers), so differences between options are not noise between streams. A win counts 1,
  a tie 0.5. First-half spots stop at halftime and use `special.halftime_wp`.
* Two rounds: every option at `n = 400`; then the best few (and the user's choice) at
  `n = 2400`.
* **Grade** = best option's win chance minus the chosen option's, in percentage points:
  ≤ 0.5 green ✓ (best), ≤ 2 yellow ≈ (close), ≤ 5 orange ! (costly), else red ✗ (big miss).
* **Daily percentile**: 4,000 simulated coaches, each with a skill `β` (log-normal). At
  each decision a coach picks option `i` with probability ∝ `f_i · exp(β · wp_i)`, where
  `f_i` is how often NFL play-callers make that choice. A coach's cost is the expected win
  chance lost over the decisions; the percentile is the share of coaches whose cost is
  higher than the player's (ties count half).
* **Coach lookalike**: the player's pass rate, deep-pass rate, fourth-down go rate and
  two-point rate (accumulated across days) as z-scores against `coaches.json`; the nearest
  coach by Euclidean distance over the measures the player has data for.

## Public API (index.js)

```js
import { Engine } from './engine/index.js';

const eng = await Engine.load('data/');          // fetches calls, plays, special, coaches, spots/index
eng.spotIndex                                     // spots/index.json
eng.dailySpotId('2026-10-16')                     // schedule lookup (UTC date string)
const spot = await eng.loadSpot(id);              // spots/<id>.json
const game = eng.newGame(spot, { mode: 'daily', seed: 12345 });   // or mode: 'survivor'
game.state                                        // GameState (above)
const d = game.decision();                        // what the user decides now, or an automatic event
//   d.kind: 'offense' | 'defense' | 'pat' | 'kickoff' | 'kick_defense' | 'auto' | 'done'
//   d.options: legal actions with display info (NFL frequency, average gain, conversion odds, FG odds…)
//   d.look: the defense's pre-snap look when the user is on offense
game.prefetch(d)                                  // starts grading this decision in workers
const r = await game.act(action);                 // grades (awaits prefetch), resolves, returns:
//   { log, grade: {chosen, best, delta, symbol, options}, wpBefore, wpAfter, state }
game.summary()                                    // end of game: grades, percentile, typical caller, lookalike, real outcome
game.toJSON() / Engine.restore(eng, json)         // save / resume
```

Actions:

```js
{ type: 'play', call: 'short_r', tempo: 'hurry', timeout: false, oob: false }
{ type: 'spike' }  { type: 'kneel', tempo: 'milk', timeout: false }
{ type: 'fg', timeout: false }  { type: 'punt' }
{ type: 'defense', look: 'blitz', timeout: false }       // look: base | blitz | load | soft
{ type: 'pat', kind: 'xp' }  { type: 'pat', kind: 'two', call: 'short_m' }
{ type: 'kickoff', onside: false }
{ type: 'kick_defense', block: true }                      // the opponent's FG or punt
{ type: 'auto' }                                           // let an automatic event happen
```
