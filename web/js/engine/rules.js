// NFL rules as small state transitions.
//
// Every exported transition takes a GameState and returns a new one (the input is never
// modified). Internally a transition clones the state once into a *draft* and applies
// mutating helpers to it; the simulator uses the same helpers through resolve.js, so the
// rules exist in exactly one place.
//
// Conventions (DATA.md): `yl` is the distance from the offense to the opponent's goal
// line, `clock` is seconds left in the quarter, teams are 0 (home) and 1 (away). Quarters
// 5+ are overtime periods.

export const QUARTER = 900;
export const OT_REG = 600;
export const OT_PLAYOFF = 900;
export const TWO_MINUTES = 120;
export const OOB_CREDIT = 4;          // seconds the clock is stopped after OOB outside the window
export const PENALTY_CREDIT = 20;     // ... after an accepted penalty outside the window
export const XP_YL = 15;              // extra point snapped from the 15
export const TWO_YL = 2;              // two-point try from the 2

export const other = (team) => 1 - team;

/** A deep-enough copy of a state for mutation. */
export function cloneState(s) {
  return {
    ...s,
    score: [s.score[0], s.score[1]],
    to: [s.to[0], s.to[1]],
    ot: s.ot ? { done: [s.ot.done[0], s.ot.done[1]] } : null,
  };
}

/** True in the second half and overtime. */
export const isSecondHalf = (s) => s.qtr >= 3;

/** Seconds left in the half (overtime: in the period). */
export const halfSeconds = (s) => (s.qtr === 1 || s.qtr === 3 ? s.clock + QUARTER : s.clock);

/** Score margin for a team. */
export const marginFor = (s, team) => s.score[team] - s.score[other(team)];

/** Does a two-minute warning exist in this quarter? (Q2, Q4, regular-season OT, even playoff OT periods.) */
export const hasTwoMinuteWarning = (s) => s.qtr === 2 || s.qtr === 4 || (s.qtr >= 5 && (!s.playoff || s.qtr % 2 === 0));

/**
 * Is the clock in the window where out-of-bounds plays and accepted penalties stop it?
 * Last 2:00 of the first half, last 5:00 of the second half and of an overtime period.
 * @param {object} s state (uses qtr)
 * @param {number} [clock] clock to test (default s.clock)
 */
export function inStopWindow(s, clock = s.clock) {
  if (s.qtr === 2) return clock <= TWO_MINUTES;
  if (s.qtr >= 4) return clock <= 300;
  return false;
}

/** Can `kicker` try an onside kick? Only when trailing in the 4th quarter or overtime. */
export const canOnside = (s, kicker) => s.qtr >= 4 && marginFor(s, kicker) < 0;

/** Field-goal distance in yards from the line of scrimmage. */
export const fgDistance = (yl) => yl + 18;

/**
 * Initial GameState from a spot file (DATA.md `spots/<id>.json`).
 * For `start.phase` 'kickoff', `start.pos` is the kicking team; for 'pat', the trying team.
 */
export function initialState(spot) {
  const teams = [spot.home, spot.away];
  const idx = (code) => {
    const i = teams.indexOf(code);
    if (i < 0) throw new Error(`team ${code} is not in ${teams.join('/')}`);
    return i;
  };
  const st = spot.start;
  const pos = idx(st.pos);
  const phase = st.phase || 'snap';
  const yl = Math.min(99, Math.max(1, st.yl ?? 75));
  return {
    teams,
    user: idx(spot.team),
    qtr: st.qtr,
    clock: st.clock,
    score: [st.score[teams[0]] ?? 0, st.score[teams[1]] ?? 0],
    pos,
    down: phase === 'snap' ? st.down || 1 : 1,
    ytg: phase === 'snap' ? Math.min(st.ytg || 10, yl) : 10,
    yl: phase === 'pat' ? XP_YL : yl,
    to: [st.to?.[teams[0]] ?? 3, st.to?.[teams[1]] ?? 3],
    phase,
    running: false,
    credit: 0,
    kicker: phase === 'kickoff' ? pos : null,
    free: false,
    receive2h: st.receive2h ? idx(st.receive2h) : other(pos),
    warned: (st.qtr === 2 || st.qtr === 4) && st.clock <= TWO_MINUTES,
    ot: st.qtr >= 5 ? { done: [0, 0] } : null,
    playoff: spot.type ? spot.type !== 'REG' : false,
    endAtHalf: st.qtr <= 2,
    winner: null,
  };
}

// ---------------------------------------------------------------------------------------
// Draft helpers (mutate their argument).

/** End the game (or, for first-half spots, the half). */
export function finishDraft(d) {
  d.phase = 'done';
  d.running = false;
  if (d.endAtHalf && d.qtr <= 2) d.winner = null;
  else d.winner = d.score[0] > d.score[1] ? 0 : d.score[1] > d.score[0] ? 1 : -1;
}

/** Start overtime: coin toss (`u` < 0.5 → home receives), kickoff, timeouts, period length. */
export function startOvertimeDraft(d, u) {
  const receiver = u < 0.5 ? 0 : 1;
  d.qtr = 5;
  d.clock = d.playoff ? OT_PLAYOFF : OT_REG;
  d.phase = 'kickoff';
  d.kicker = other(receiver);
  d.pos = d.kicker;
  d.free = false;
  d.to = d.playoff ? [3, 3] : [2, 2];
  d.warned = false;
  d.running = false;
  d.credit = 0;
  d.ot = { done: [0, 0] };
}

/**
 * The clock has reached 0:00 with no try pending: end the quarter, half, regulation or
 * overtime period. `u` is a uniform draw for the overtime coin toss.
 */
export function endPeriodDraft(d, u = 0.5) {
  d.running = false;
  d.credit = 0;
  if (d.qtr === 1 || d.qtr === 3) {
    d.qtr += 1;
    d.clock = QUARTER;
    return;
  }
  if (d.qtr === 2) {
    if (d.endAtHalf) {
      finishDraft(d);
      return;
    }
    d.qtr = 3;
    d.clock = QUARTER;
    d.phase = 'kickoff';
    d.kicker = other(d.receive2h);
    d.pos = d.kicker;
    d.free = false;
    d.to = [3, 3];
    d.warned = false;
    return;
  }
  const tied = d.score[0] === d.score[1];
  if (d.qtr === 4) {
    if (tied) startOvertimeDraft(d, u);
    else finishDraft(d);
    return;
  }
  if (!d.playoff || !tied) {
    finishDraft(d);
    return;
  }
  d.qtr += 1;
  d.clock = OT_PLAYOFF;
  d.warned = false;
  if (d.qtr % 2 === 1) d.to = [3, 3];
}

/**
 * Overtime: a team's possession has ended (score, punt, turnover, missed kick). Once both
 * teams have finished a possession, any difference in score ends the game.
 */
export function possessionEndsDraft(d, team) {
  if (!d.ot || d.phase === 'done') return;
  d.ot.done[team] += 1;
  if (d.ot.done[0] >= 1 && d.ot.done[1] >= 1 && d.score[0] !== d.score[1]) finishDraft(d);
}

/** Give the ball to `team` at `yl`, first and ten (or goal). */
export function giveBallDraft(d, team, yl) {
  d.pos = team;
  d.yl = Math.min(99, Math.max(1, Math.round(yl)));
  d.down = 1;
  d.ytg = Math.min(10, d.yl);
  d.phase = 'snap';
  d.kicker = null;
  d.free = false;
}

/** Set up a kickoff by `kicker` (free kick after a safety when `free`). */
export function kickoffDraft(d, kicker, free = false) {
  d.phase = 'kickoff';
  d.kicker = kicker;
  d.pos = kicker;
  d.free = free;
  d.running = false;
  d.credit = 0;
}

/**
 * Touchdown by `team` (offense or a return). Sets up the try unless it cannot change the
 * outcome: a walk-off in overtime, or the last play of regulation when the margin after
 * the touchdown is outside -2..0.
 * @param {boolean} defensive scored by the team without the ball at the snap
 */
export function touchdownDraft(d, team, defensive = false) {
  d.score[team] += 6;
  d.running = false;
  d.credit = 0;
  d.pos = team;
  d.kicker = null;
  d.free = false;
  if (d.ot) {
    const leads = marginFor(d, team) > 0;
    if (defensive || (leads && d.ot.done[other(team)] >= 1)) {
      finishDraft(d);
      return;
    }
  }
  const m = marginFor(d, team);
  if (d.qtr === 4 && d.clock <= 0 && (m > 0 || m < -2)) {
    endPeriodDraft(d);
    return;
  }
  d.phase = 'pat';
  d.down = 1;
  d.yl = XP_YL;
  d.ytg = XP_YL;
}

/** Safety: two points for the defense, free kick by the conceding team. Ends overtime. */
export function safetyDraft(d, conceding) {
  d.score[other(conceding)] += 2;
  if (d.ot) {
    finishDraft(d);
    return;
  }
  kickoffDraft(d, conceding, true);
}

/** After a score or kick with time gone, end the period instead of kicking off. */
function maybeEndAfterScore(d, u) {
  if (d.phase !== 'done' && d.phase !== 'pat' && d.clock <= 0) endPeriodDraft(d, u);
}

/**
 * Run the game clock for a play of `dur` seconds; applies the two-minute warning when the
 * play crosses 2:00. Returns true if the warning was triggered.
 */
export function playTimeDraft(d, dur) {
  const c0 = d.clock;
  d.clock = Math.max(0, c0 - dur);
  if (hasTwoMinuteWarning(d) && !d.warned && c0 > TWO_MINUTES && d.clock <= TWO_MINUTES) {
    d.warned = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Exported transitions (pure).

/**
 * A team calls a timeout before the snap: the clock stops (after about one second of
 * reaction if it was running, never past the two-minute warning or 0:00).
 * @returns {object} the new state (unchanged if the team has none left)
 */
export function callTimeout(s, team) {
  if (s.to[team] <= 0 || s.phase === 'done') return s;
  const d = cloneState(s);
  d.to[team] -= 1;
  if (d.running) {
    let c = d.clock > 1.5 ? d.clock - 1 : d.clock;
    if (hasTwoMinuteWarning(d) && !d.warned && d.clock > TWO_MINUTES && c <= TWO_MINUTES) c = d.clock;
    d.clock = c;
  }
  d.running = false;
  d.credit = 0;
  return d;
}

/**
 * Time that runs off before the snap with the clock running (minus any restart credit).
 * Stops at the two-minute warning; ends the period at 0:00.
 * @param {object} s
 * @param {number} secs seconds the offense takes to snap
 * @param {number} [u] uniform draw for an overtime coin toss
 * @returns {{state: object, stop: null|'2mw'|'period'}}
 */
export function preSnapRunoff(s, secs, u = 0.5) {
  if (!s.running || s.phase === 'done') return { state: s, stop: null, secs: 0 };
  const d = cloneState(s);
  const run = Math.max(0, secs - d.credit);
  d.credit = 0;
  const c0 = d.clock;
  const c1 = c0 - run;
  if (hasTwoMinuteWarning(d) && !d.warned && c0 > TWO_MINUTES && c1 <= TWO_MINUTES) {
    d.clock = TWO_MINUTES;
    d.warned = true;
    d.running = false;
    return { state: d, stop: '2mw', secs: c0 - TWO_MINUTES };
  }
  if (c1 <= 0) {
    d.clock = 0;
    endPeriodDraft(d, u);
    return { state: d, stop: 'period', secs: c0 };
  }
  d.clock = c1;
  return { state: d, stop: null, secs: run };
}

/**
 * Apply the outcome of a scrimmage snap (or kneel / spike) to a state in phase 'snap'.
 * @param {object} s
 * @param {object} o outcome:
 *   gain (net yards, ignored on turnovers), dur (seconds),
 *   inc, oob, pen (accepted penalty), noPlay, auto1, spike, kneel,
 *   td (offensive touchdown), safety,
 *   tov (turnover) with defYl (the defense's new yl; <= 0 means returned for a TD), defTd
 * @param {number} [u] uniform draw for an overtime coin toss
 * @returns {{state: object, first: boolean, downs: boolean, warning: boolean, untimed: boolean}}
 */
export function applySnap(s, o, u = 0.5) {
  const d = cloneState(s);
  const off = d.pos;
  const def = other(off);
  const res = { state: d, first: false, downs: false, warning: false, untimed: false };
  res.warning = playTimeDraft(d, o.dur);
  const expired = d.clock <= 0;
  const window = inStopWindow(d);
  d.credit = 0;

  if (o.tov) {
    possessionEndsDraft(d, off);
    if (d.phase === 'done') return res;
    if (o.defTd || o.defYl <= 0) touchdownDraft(d, def, true);
    else giveBallDraft(d, def, o.defYl >= 100 ? 80 : o.defYl);
    d.running = false;
  } else if (o.td) {
    touchdownDraft(d, off);
  } else if (o.safety) {
    safetyDraft(d, off);
  } else {
    const newYl = Math.min(99, Math.max(1, d.yl - o.gain));
    const first = o.auto1 || o.gain >= d.ytg;
    if (first) {
      d.down = 1;
      d.ytg = Math.min(10, newYl);
      res.first = true;
    } else if (o.noPlay) {
      d.ytg = Math.min(newYl, Math.max(1, d.ytg - o.gain));
    } else {
      d.down += 1;
      d.ytg = Math.min(newYl, Math.max(1, d.ytg - o.gain));
    }
    d.yl = newYl;
    if (d.down > 4) {
      res.downs = true;
      possessionEndsDraft(d, off);
      if (d.phase === 'done') return res;
      giveBallDraft(d, def, 100 - newYl);
      d.running = false;
    } else {
      const stop = o.inc || o.spike || (o.oob && window) || (o.pen && window);
      d.running = !stop;
      if (!stop && o.pen) d.credit = PENALTY_CREDIT;
      else if (!stop && o.oob) d.credit = OOB_CREDIT;
    }
  }
  if (res.warning && d.phase !== 'done') d.running = false;

  if (expired && d.phase === 'snap') {
    // An accepted defensive foul on the last play gives the offense an untimed down.
    if (o.pen && o.gain > 0 && d.pos === off) {
      res.untimed = true;
      d.running = false;
    } else {
      endPeriodDraft(d, u);
    }
  } else if (expired && d.phase === 'kickoff') {
    endPeriodDraft(d, u);
  }
  return res;
}

/**
 * Apply a field-goal attempt by the team in possession.
 * @param {object} s
 * @param {{made: boolean, blocked?: boolean, retTd?: boolean, roughing?: boolean, dur: number}} o
 * @param {number} [u] coin-toss draw
 */
export function applyFieldGoal(s, o, u = 0.5) {
  const d = cloneState(s);
  const off = d.pos;
  const def = other(off);
  const yl = d.yl;
  playTimeDraft(d, o.dur);
  d.running = false;
  d.credit = 0;
  if (o.made) {
    d.score[off] += 3;
    kickoffDraft(d, off);
    possessionEndsDraft(d, off);
  } else if (o.roughing) {
    giveBallDraft(d, off, Math.max(1, yl - 15));
    if (d.clock <= 0) return d;   // untimed down
  } else if (o.blocked && o.retTd) {
    possessionEndsDraft(d, off);
    if (d.phase !== 'done') touchdownDraft(d, def, true);
  } else {
    possessionEndsDraft(d, off);
    if (d.phase !== 'done') giveBallDraft(d, def, o.blocked ? 100 - (yl + 7) : yl + 7 <= 20 ? 80 : 100 - (yl + 7));
  }
  maybeEndAfterScore(d, u);
  return d;
}

/**
 * Apply a punt by the team in possession.
 * @param {object} s
 * @param {{recvYl: number, retTd?: boolean, kickRec?: boolean, roughing?: boolean, dur: number}} o
 *   recvYl is the receiving team's yl at its next snap (DATA.md)
 */
export function applyPunt(s, o, u = 0.5) {
  const d = cloneState(s);
  const off = d.pos;
  const def = other(off);
  const yl = d.yl;
  playTimeDraft(d, o.dur);
  d.running = false;
  d.credit = 0;
  if (o.roughing) {
    giveBallDraft(d, off, Math.max(1, yl - 15));
    if (d.clock <= 0) return d;
  } else if (o.kickRec) {
    giveBallDraft(d, off, 100 - o.recvYl);
  } else {
    possessionEndsDraft(d, off);
    if (d.phase === 'done') return d;
    if (o.retTd) touchdownDraft(d, def);
    else giveBallDraft(d, def, o.recvYl);
  }
  maybeEndAfterScore(d, u);
  return d;
}

/**
 * Apply a kickoff (or free kick) by `s.kicker`.
 * @param {object} s
 * @param {{recvYl: number, retTd?: boolean, kickRec?: boolean, dur: number}} o
 *   recvYl is the receiving team's yl; when the kicking team recovers it starts at 100 - recvYl
 */
export function applyKickoff(s, o, u = 0.5) {
  const d = cloneState(s);
  const kicker = d.kicker;
  const recv = other(kicker);
  playTimeDraft(d, o.dur);
  d.running = false;
  d.credit = 0;
  if (o.retTd) touchdownDraft(d, recv);
  else if (o.kickRec) giveBallDraft(d, kicker, 100 - o.recvYl);
  else giveBallDraft(d, recv, o.recvYl);
  maybeEndAfterScore(d, u);
  return d;
}

/**
 * Apply a try (extra point or two-point conversion) by the team in possession, then set
 * up the kickoff (or end the period / game).
 * @param {object} s state in phase 'pat'
 * @param {{two: boolean, good: boolean}} o
 */
export function applyTry(s, o, u = 0.5) {
  const d = cloneState(s);
  const team = d.pos;
  if (o.good) d.score[team] += o.two ? 2 : 1;
  kickoffDraft(d, team);
  possessionEndsDraft(d, team);
  maybeEndAfterScore(d, u);
  return d;
}

// ---------------------------------------------------------------------------------------
// Display helpers.

const ORD = ['', '1st', '2nd', '3rd', '4th'];

/** Clock text such as "Q4 1:58" or "OT 7:12". */
export function clockText(s) {
  const t = Math.max(0, Math.ceil(s.clock - 1e-9));
  const mm = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, '0');
  const q = s.qtr <= 4 ? `Q${s.qtr}` : s.qtr === 5 ? 'OT' : `OT${s.qtr - 4}`;
  return `${q} ${mm}:${ss}`;
}

/** Down and distance such as "3rd & 4" or "1st & Goal". */
export function downText(s) {
  if (s.phase === 'pat') return 'Try';
  if (s.phase === 'kickoff') return s.free ? 'Free kick' : 'Kickoff';
  const goal = s.ytg >= s.yl;
  return `${ORD[Math.min(4, s.down)]} & ${goal ? 'Goal' : s.ytg}`;
}

/** Ball spot from a team's point of view: "own 25", "opp 35", "50". */
export function spotText(yl, ownTeamView = true) {
  if (yl === 50) return '50';
  if (yl > 50) return ownTeamView ? `own ${100 - yl}` : `${100 - yl}`;
  return ownTeamView ? `opp ${yl}` : `${yl}`;
}

/** Ball spot with team abbreviations: "KC 25" (the offense's own 25) or "NO 35". */
export function ballText(s) {
  if (s.yl === 50) return '50';
  const side = s.yl > 50 ? s.teams[s.pos] : s.teams[other(s.pos)];
  return `${side} ${s.yl > 50 ? 100 - s.yl : s.yl}`;
}
