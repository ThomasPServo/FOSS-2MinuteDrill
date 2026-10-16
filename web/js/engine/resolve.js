// Resolution of one game event (a snap, a try or a kickoff) with real plays.
//
// A snap goes: offense timeout -> runoff before the snap -> the play. For a scrimmage play
// the engine draws one real NFL play of the chosen call from a pool of plays in a similar
// situation (data.js), tilted toward better or worse outcomes by the matchup against the
// defense's look and by team strength, and applies its yards, flags and duration at the
// current spot (rules.js).
//
// Internal actions use call *indices*. The Game converts the public string ids.

import { FL, KO_FL, PUNT_FL, LOOKS, gameMode, sitKey } from './data.js';
import { SLOT } from './rng.js';
import {
  applyFieldGoal, applyKickoff, applyPunt, applySnap, applyTry, callTimeout,
  fgDistance, halfSeconds, isSecondHalf, marginFor, other, preSnapRunoff, TWO_YL,
} from './rules.js';

export const TAU_M = 0.25;            // matchup tilt: mean EPA moves by TAU_M * s pool sds
export const DELTA_CAP = 0.15;        // team strength cap (EPA per play)
export const BLOCK_MULT = 4;          // block attempt: block chance x4
export const ROUGHING = 0.04;         // block attempt: roughing / running-into-the-kicker chance
export const FIRE_DRILL_LOGIT = -0.3; // rushed field goal

/**
 * Matchup of a call against a defensive look, s in [-1, 1] (offense's point of view).
 * Columns: base, blitz, load (8+ in the box), soft (light box, no blitz).
 * Blitzes are beaten by quick throws and screens; loaded boxes by play action and deep
 * shots; light boxes by runs. The reverse loses.
 */
const MATCHUP_BY_ID = {
  run_out_l: [0, 0, -1, 1], run_out_r: [0, 0, -1, 1],
  run_tackle_l: [0, 0, -1, 1], run_tackle_r: [0, 0, -1, 1],
  run_guard_l: [0, 0, -1, 1], run_guard_r: [0, 0, -1, 1],
  run_middle: [0, 0, -1, 1],
  qb_sneak: [0, 0, -0.5, 0.5],
  qb_run: [0, 0.5, -1, 1],
  rpo_run: [0, 0, -0.5, 1],
  rpo_pass: [0, 0.5, 1, -0.5],
  short_l: [0, 1, 0.5, -0.5], short_m: [0, 1, 0.5, -0.5], short_r: [0, 1, 0.5, -0.5],
  screen: [0, 1, 0.5, -0.5],
  deep_l: [0, -1, 1, -1], deep_m: [0, -1, 1, -1], deep_r: [0, -1, 1, -1],
  pa_deep: [0, -1, 1, -1],
  pa_short: [0, -0.5, 1, 0],
  rollout: [0, -0.5, 0.5, 0],
  hail_mary: [0, 0, 0, 0],
  flea_flicker: [0, -1, 1, -1], receiver_pass: [0, -1, 1, -1],
  end_around: [0, 1, -1, 0],
  direct_snap: [0, 0, -1, 1],
};

/** Raw matchup table as a Float32Array indexed `call * 4 + look` (cached on the library). */
export function matchupTable(lib) {
  if (!lib._matchup) {
    const t = new Float32Array(lib.nCalls * 4);
    lib.calls.forEach((c, i) => {
      const row = MATCHUP_BY_ID[c.id] || [0, 0, 0, 0];
      for (let j = 0; j < 4; j++) t[i * 4 + j] = row[j];
    });
    lib._matchup = t;
    lib._matchMeans = new Array(lib.nCalls);
  }
  return lib._matchup;
}

/**
 * Matchup of a call against a look in a situation, centred so that the call's average over
 * the looks NFL defenses show in that situation is zero. Light boxes are by far the most
 * common look, so uncentred scores would make runs better and deep passes worse than the
 * real data on average; centred, a call keeps its real average and reading the look pays.
 * Clipped to [-1.5, 1.5].
 */
export function matchupScore(lib, call, look, key) {
  const raw = matchupTable(lib);
  let means = lib._matchMeans[key];
  if (!means) {
    const mix = lib.lookMix(key);
    means = new Float32Array(lib.nCalls);
    for (let c = 0; c < lib.nCalls; c++) for (let j = 0; j < 4; j++) means[c] += mix[j] * raw[c * 4 + j];
    lib._matchMeans[key] = means;
  }
  return Math.min(1.5, Math.max(-1.5, raw[call * 4 + look] - means[call]));
}

// ---------------------------------------------------------------------------------------
// Team context.

const GROUPS = {
  QB: 'QB', RB: 'RB', HB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
  T: 'OL', G: 'OL', C: 'OL', OT: 'OL', OG: 'OL', OL: 'OL', LT: 'OL', LG: 'OL', RG: 'OL', RT: 'OL',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL',
  LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
  CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DB: 'DB', SAF: 'DB',
  K: 'K', P: 'P',
};

/** Position group of a roster position string. */
export const groupOf = (pos) => GROUPS[String(pos || '').toUpperCase()] || 'OTHER';

function meanRating(players, groups, fallback = 70) {
  let s = 0;
  let n = 0;
  for (const p of players || []) {
    if (groups.includes(groupOf(p.pos)) && Number.isFinite(p.r)) {
      s += p.r;
      n++;
    }
  }
  return n ? s / n : fallback;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Static per-game context used by every resolution and simulation: team-strength tilts,
 * kicker/punter adjustments, weather and the point spread. JSON-serializable.
 * @param {object} spot spots/<id>.json
 * @returns {{user: number, delta: number[][], fgShift: number[], puntShift: number[],
 *   weather: {indoor: boolean, wind: number}, spread: number, playoff: boolean}}
 */
export function buildContext(spot) {
  const teams = [spot.home, spot.away];
  const st = spot.strength || {};
  const pl = spot.players || {};
  const delta = [0, 1].map((t) => {
    const o = teams[t];
    const dTeam = teams[1 - t];
    const so = st[o] || {};
    const sd = st[dTeam] || {};
    const off = pl[o]?.off || [];
    const def = pl[dTeam]?.def || [];
    const offPass = 0.4 * meanRating(off, ['QB']) + 0.35 * meanRating(off, ['WR', 'TE']) + 0.25 * meanRating(off, ['OL']);
    const offRun = 0.4 * meanRating(off, ['RB']) + 0.6 * meanRating(off, ['OL']);
    const defPass = 0.6 * meanRating(def, ['DB']) + 0.4 * meanRating(def, ['DL', 'LB']);
    const defRun = 0.7 * meanRating(def, ['DL', 'LB']) + 0.3 * meanRating(def, ['DB']);
    const run = (so.off_rush || 0) + (sd.def_rush || 0) + 0.0008 * (offRun - defRun);
    const pass = (so.off_pass || 0) + (sd.def_pass || 0) + 0.0008 * (offPass - defPass);
    return [clamp(run, -DELTA_CAP, DELTA_CAP), clamp(pass, -DELTA_CAP, DELTA_CAP)];
  });
  const rating = (t, role) => pl[teams[t]]?.[role]?.r;
  const fgShift = [0, 1].map((t) => (Number.isFinite(rating(t, 'k')) ? (rating(t, 'k') - 70) * 0.004 : 0));
  const puntShift = [0, 1].map((t) => (Number.isFinite(rating(t, 'p')) ? (rating(t, 'p') - 70) * 0.05 : 0));
  return {
    user: teams.indexOf(spot.team),
    delta,
    fgShift,
    puntShift,
    weather: { indoor: !!spot.indoor, wind: spot.indoor ? 0 : spot.wind || 0 },
    spread: spot.spread || 0,
    playoff: spot.type ? spot.type !== 'REG' : false,
  };
}

/** The team's point spread (positive = favoured). */
export const spreadFor = (ctx, team) => (team === 0 ? ctx.spread : -ctx.spread);

/** Situation key of the snap in state `s`. */
export function situationKey(s) {
  const mode = gameMode(isSecondHalf(s), halfSeconds(s), marginFor(s, s.pos));
  return sitKey(mode, s.down, s.ytg, s.yl);
}

/** Field-goal make probability for the team with the ball at `yl`. */
export function fgChance(lib, ctx, team, yl, fire = false) {
  return lib.fgProb(yl, ctx.weather, ctx.fgShift[team] + (fire ? FIRE_DRILL_LOGIT : 0));
}

// ---------------------------------------------------------------------------------------
// Outcome of a drawn play at the current spot.

/**
 * Translate real play `i` to the current spot.
 * @returns {object} outcome for rules.applySnap, plus the real play index
 */
export function playOutcome(lib, i, s) {
  const yl = s.yl;
  const fl = lib.fl[i];
  const yds = lib.yds[i];
  const o = {
    play: i, gain: 0, dur: lib.dur[i] / 10, inc: !!(fl & FL.INC), oob: !!(fl & FL.OOB),
    pen: !!(fl & FL.PEN), noPlay: !!(fl & FL.NOPLAY), auto1: !!(fl & FL.AUTO1),
    td: false, safety: false, tov: false, defYl: 0, defTd: false, spike: false, kneel: false,
  };
  if (o.dur <= 0) o.dur = fl & FL.INC ? lib.durs.incomplete : lib.isPass[lib.call[i]] ? lib.durs.pass : lib.durs.run;
  if (fl & (FL.INT | FL.FUM)) {
    if ((fl & FL.FUM) && !(fl & FL.INT) && yds >= yl) {
      o.td = true;                                     // the fumble now happens past the goal line
      o.gain = yl;
    } else {
      o.tov = true;
      o.defYl = 100 - yl + lib.tov[i];
      o.defTd = !!(fl & FL.DEFTD) || o.defYl <= 0;
      o.gain = yds;
    }
    return o;
  }
  if (o.noPlay) {
    let g = yds;
    if (g > 0) g = Math.min(g, g >= 15 ? yl - 1 : Math.floor(yl / 2));
    else if (g < 0) g = Math.max(g, -Math.floor((100 - yl) / 2));
    o.gain = g;
    return o;
  }
  if (fl & FL.TD) {
    if (yds >= 0.6 * yl) {
      o.td = true;
      o.gain = yl;
    } else o.gain = yds;
    return o;
  }
  if (yds >= yl) {
    if (o.pen) o.gain = yl - 1;                        // penalty yardage never scores
    else {
      o.td = true;
      o.gain = yl;
    }
    return o;
  }
  o.gain = yds;
  if (yl - yds >= 100) o.safety = true;
  return o;
}

// ---------------------------------------------------------------------------------------
// Snaps.

const TEMPO_DIST = { hurry: 'hurry', normal: 'normal', milk: 'kill' };

/** Seconds the offense lets run off before the snap for an action (clock running). */
function snapRunoff(lib, s, a, dr) {
  if (a.type === 'spike') return dr.range(SLOT.RUNOFF, 5, 12);
  if (a.type === 'kneel' && a.tempo === 'milk') return dr.range(SLOT.RUNOFF, 38, 40);
  let secs = lib.runoff(TEMPO_DIST[a.tempo] || 'normal', dr.u(SLOT.RUNOFF));
  // `keep`: seconds the offense makes sure are left at the snap. A team that is not ahead in
  // the second half never lets the clock expire before a snap it needs, whatever its tempo.
  const keep = a.keep || (s.qtr >= 3 && marginFor(s, s.pos) <= 0 ? 1 : 0);
  if (keep) secs = Math.min(secs, Math.max(0, s.clock - keep));
  return secs;
}

/**
 * Timeouts and runoff before an offensive snap. Returns the state at the snap (or after the
 * period ended) and the pre-snap events.
 */
function preSnap(lib, s, a, dr, ev) {
  const off = s.pos;
  if (a.timeout && !a.rundown && s.running && s.to[off] > 0) {
    s = callTimeout(s, off);
    ev.pre.push({ type: 'timeout', team: off, clock: s.clock, qtr: s.qtr });
  }
  if (!s.running) return s;
  let secs;
  let fire = false;
  // Run it down: the timeout (one second of reaction) leaves 0:03 for the kick.
  if (a.type === 'fg' && a.rundown && s.to[off] > 0) secs = Math.max(0, s.clock - 4);
  else if (a.type === 'fg' && (halfSeconds(s) <= 25 || a.tempo === 'hurry')) {
    secs = dr.range(SLOT.RUNOFF, 7, 12);
    fire = true;
  } else secs = snapRunoff(lib, s, a, dr);
  const qtr = s.qtr;
  const r = preSnapRunoff(s, secs, dr.u(SLOT.TOSS));
  ev.pre.push({ type: 'runoff', secs: r.secs, stop: r.stop, clock: r.state.clock, qtr });
  s = r.state;
  if (a.type === 'fg' && a.rundown && s.running && s.to[off] > 0 && s.phase === 'snap') {
    s = callTimeout(s, off);
    ev.pre.push({ type: 'timeout', team: off, clock: s.clock, qtr: s.qtr, why: 'kick' });
  }
  ev.fire = fire && s.running;
  return s;
}

/**
 * Resolve one offensive snap.
 * @param {import('./data.js').Library} lib
 * @param {object} ctx buildContext()
 * @param {object} s0 state in phase 'snap'
 * @param {object} a offense action: {type: 'play'|'kneel'|'spike'|'fg'|'punt', call, tempo,
 *   timeout, oob, rundown, keep}
 * @param {{look?: number, block?: boolean}} d defense: look index (-1 = none: no look
 *   filter or matchup) and, on kicks, whether it rushes to block
 * @param {import('./rng.js').Draws} dr random draws of this event
 * @returns {{state: object, ev: object}}
 */
export function resolveSnap(lib, ctx, s0, a, d, dr) {
  const ev = { type: a.type, team: s0.pos, pre: [], clock0: 0, qtr0: s0.qtr, out: null };
  let s = preSnap(lib, s0, a, dr, ev);
  if (s.phase !== 'snap' || s.pos !== s0.pos) {
    ev.type = 'expired';
    return { state: s, ev };
  }
  ev.clock0 = s.clock;
  ev.qtr0 = s.qtr;
  ev.yl0 = s.yl;
  ev.down0 = s.down;
  ev.ytg0 = s.ytg;
  const u = dr.u(SLOT.PLAY);
  switch (a.type) {
    case 'fg': return resolveFieldGoal(lib, ctx, s, d, dr, ev, u);
    case 'punt': return resolvePunt(lib, ctx, s, d, dr, ev, u);
    case 'kneel':
    case 'spike': {
      const o = {
        gain: a.type === 'kneel' ? (s.yl < 99 ? -1 : 0) : 0,
        dur: a.type === 'kneel' ? lib.durs.kneel : lib.durs.spike,
        inc: a.type === 'spike', spike: a.type === 'spike', kneel: a.type === 'kneel',
        oob: false, pen: false, noPlay: false, auto1: false, td: false, safety: false, tov: false,
      };
      burnClock(s, o, a);
      return finishSnap(s, o, ev, dr);
    }
    default: {
      const key = situationKey(s);
      const look = d.look ?? -1;
      const pool = lib.drawPool(a.call, key, look, dr.u(SLOT.PRESSURE));
      const m = look >= 0 ? matchupScore(lib, a.call, look, key) : 0;
      const sd = pool.sd;
      const delta = ctx.delta[s.pos][lib.isPass[a.call]];
      const k = (TAU_M * m) / sd + delta / (sd * sd);
      const i = lib.draw(pool, k, !!a.oob, u);
      const o = playOutcome(lib, i, s);
      burnClock(s, o, a);
      ev.call = a.call;
      ev.look = look;
      ev.matchup = m;
      ev.oobTry = !!a.oob;
      return finishSnap(s, o, ev, dr);
    }
  }
}

/** A leading offense with 8 seconds or less holds the ball until time expires. */
function burnClock(s, o, a) {
  if (a.type !== 'spike' && marginFor(s, s.pos) > 0 && halfSeconds(s) <= 8 && !o.inc && !o.td && !o.tov) {
    o.dur = Math.max(o.dur, halfSeconds(s) + 0.5);
  }
}

function finishSnap(s, o, ev, dr) {
  const r = applySnap(s, o, dr.u(SLOT.TOSS));
  ev.out = o;
  ev.first = r.first;
  ev.downs = r.downs;
  ev.warning = r.warning;
  ev.untimed = r.untimed;
  return { state: r.state, ev };
}

function resolveFieldGoal(lib, ctx, s, d, dr, ev, u) {
  const off = s.pos;
  const fire = !!ev.fire;
  const p = fgChance(lib, ctx, off, s.yl, fire);
  const base = lib.special.fg?.blocked ?? 0.012;
  const pb = d.block ? Math.min(0.25, BLOCK_MULT * base) : base;
  const pMake = d.block ? (p * (1 - pb)) / (1 - base) : p;
  const blocked = u < pb;
  const made = !blocked && u < pb + pMake;
  const roughing = d.block && !made && dr.u(SLOT.ROUGH) < ROUGHING;
  const retTd = blocked && dr.u(SLOT.PICK) < 0.1;
  const dur = roughing ? 4 : blocked ? (retTd ? 8 : 4) : 5;
  ev.fg = { dist: fgDistance(s.yl), p, made, blocked, roughing, retTd, fire };
  ev.out = { dur };
  return { state: applyFieldGoal(s, { made, blocked, retTd, roughing, dur }, dr.u(SLOT.TOSS)), ev };
}

function resolvePunt(lib, ctx, s, d, dr, ev, u) {
  const off = s.pos;
  const pool = lib.puntPool(s.yl);
  const base = lib.punt.blockRate;
  const roughing = d.block && dr.u(SLOT.ROUGH) < ROUGHING;
  const pick = dr.u(SLOT.PICK);
  let recvYl;
  let fl;
  let blocked = false;
  if (roughing) {
    recvYl = 0;
    fl = 0;
  } else if (d.block && u < Math.min(0.25, BLOCK_MULT * base) && lib.punt.blockedIdx.length) {
    const j = lib.punt.blockedIdx[Math.floor(pick * lib.punt.blockedIdx.length)];
    blocked = true;
    fl = lib.punt.fl[j];
    recvYl = 100 - s.yl + (lib.punt.recv[j] - (100 - lib.punt.yl[j]));
  } else {
    const list = d.block ? pool.clean : pool.all;
    const j = list[Math.floor(pick * list.length)];
    fl = lib.punt.fl[j];
    blocked = !!(fl & PUNT_FL.BLOCKED);
    // Moving the punt back by x yards moves the receiving team's start x yards back too.
    recvYl = lib.punt.recv[j] - (s.yl - lib.punt.yl[j]);
    if (!blocked && !(fl & (PUNT_FL.TOUCHBACK | PUNT_FL.RET_TD | PUNT_FL.KICK_REC))) {
      recvYl += ctx.puntShift[off] + (d.block ? 4 : 0);
    }
  }
  const retTd = !roughing && (!!(fl & PUNT_FL.RET_TD) || recvYl <= 0);
  const kickRec = !roughing && !retTd && !!(fl & PUNT_FL.KICK_REC);
  if ((fl & PUNT_FL.TOUCHBACK) || recvYl >= 100) {
    fl |= PUNT_FL.TOUCHBACK;
    recvYl = 80;
  }
  recvYl = Math.min(99, Math.max(1, Math.round(recvYl)));
  const quiet = fl & (PUNT_FL.TOUCHBACK | PUNT_FL.DOWNED);
  const dur = roughing ? 4 : blocked ? 4 : retTd ? 12 : quiet ? 5.5 : 9;
  ev.punt = { recvYl, retTd, kickRec, blocked, roughing, touchback: !!(fl & PUNT_FL.TOUCHBACK), net: s.yl - (100 - recvYl) };
  ev.out = { dur };
  return { state: applyPunt(s, { recvYl, retTd, kickRec, roughing, dur }, dr.u(SLOT.TOSS)), ev };
}

// ---------------------------------------------------------------------------------------
// Tries and kickoffs.

/**
 * Resolve a try. Two-point tries draw a real play of the call from its two-point pool;
 * plays wiped out by a penalty fall back to the league two-point rate.
 * @param {{kind: 'xp'|'two', call?: number}} a
 */
export function resolvePat(lib, ctx, s, a, dr) {
  const team = s.pos;
  const ev = { type: a.kind === 'two' ? 'two' : 'xp', team, pre: [], clock0: s.clock, qtr0: s.qtr };
  const u = dr.u(SLOT.PLAY);
  let good;
  if (a.kind === 'two') {
    const pool = lib.twoDrawPool(a.call, dr.u(SLOT.PRESSURE));
    const sd = pool.sd;
    const k = ctx.delta[team][lib.isPass[a.call]] / (sd * sd);
    const i = lib.draw(pool, k, false, u);
    const o = playOutcome(lib, i, { yl: TWO_YL });
    good = o.pen ? dr.u(SLOT.PICK) < (lib.special.two?.rate ?? 0.48) : o.td && !o.tov;
    ev.call = a.call;
    ev.out = o;
  } else {
    const rate = lib.special.xp?.rate ?? 0.95;
    const z = Math.log(rate / (1 - rate)) + ctx.fgShift[team];
    good = u < 1 / (1 + Math.exp(-z));
  }
  ev.good = good;
  return { state: applyTry(s, { two: a.kind === 'two', good }, dr.u(SLOT.TOSS)), ev };
}

/** Onside recovery rate (special.onside.rate, at least 4%). */
export const onsideRate = (lib) => Math.max(0.04, lib.special.onside?.rate || 0);

/**
 * Resolve a kickoff (or a free kick after a safety).
 * @param {{onside?: boolean}} a
 */
export function resolveKickoff(lib, ctx, s, a, dr) {
  const kicker = s.kicker;
  const ev = { type: 'kickoff', team: kicker, pre: [], clock0: s.clock, qtr0: s.qtr, onside: !!a.onside, free: s.free };
  const u = dr.u(SLOT.PLAY);
  let o;
  if (a.onside) {
    const rec = u < onsideRate(lib);
    o = { recvYl: 46, kickRec: rec, retTd: false, dur: 3 };
  } else {
    const n = lib.kickoff.recv.length;
    const j = Math.min(n - 1, Math.floor(u * n));
    const fl = lib.kickoff.fl[j];
    let recvYl = lib.kickoff.recv[j];
    if (s.free) recvYl = Math.min(75, Math.max(40, recvYl - 10));
    const quiet = fl & (KO_FL.TOUCHBACK | KO_FL.OOB);
    o = {
      recvYl,
      retTd: !!(fl & KO_FL.RET_TD),
      kickRec: !!(fl & KO_FL.KICK_REC) && !(fl & KO_FL.RET_TD),
      dur: quiet ? 0 : dr.range(SLOT.PICK, 5, 7),
      touchback: !!(fl & KO_FL.TOUCHBACK),
    };
  }
  ev.ko = o;
  ev.out = { dur: o.dur };
  return { state: applyKickoff(s, o, dr.u(SLOT.TOSS)), ev };
}

/** Apply a defensive timeout before the snap (no-op unless the clock runs and one is left). */
export function defenseTimeout(s) {
  const def = other(s.pos);
  if (!s.running || s.to[def] <= 0 || s.phase !== 'snap') return { state: s, ev: null };
  const t = callTimeout(s, def);
  return { state: t, ev: { type: 'timeout', team: def, clock: t.clock, qtr: t.qtr, pre: [] } };
}

// ---------------------------------------------------------------------------------------
// Narration and animation hints (live game only; the simulator never calls these).

const PLAYER_GROUPS = [['QB'], ['RB'], ['WR'], ['TE'], ['WR', 'TE', 'RB']];
const LOC_NAMES = ['left', 'middle', 'right'];

/**
 * Deterministic pick (by hash `h`) of a player of the given groups: better-rated players
 * more often, fullbacks rarely (the halfback carries and catches most).
 */
function pickPlayer(players, groups, h) {
  const pool = (players || []).filter((p) => groups.includes(groupOf(p.pos)));
  if (!pool.length) return null;
  pool.sort((a, b) => (b.r || 0) - (a.r || 0));
  const weights = pool.map((p, i) => (String(p.pos).toUpperCase() === 'FB' ? 0.15 : 1) / (i + 1));
  const total = weights.reduce((x, y) => x + y, 0);
  let t = ((h % 10007) / 10007) * total;
  for (let i = 0; i < pool.length; i++) {
    t -= weights[i];
    if (t < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

const nameOf = (p, fallback) => (p ? p.short || p.name : fallback);
const playerRef = (p) => (p ? { id: p.id, name: p.name, short: p.short || p.name, pos: p.pos, num: p.num ?? null, r: p.r ?? null } : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const yardsText = (g) => (g > 0 ? plural(g, 'yard') : g < 0 ? `loss of ${-g}` : 'no gain');
// result-card headline for a gain: "+1 yard", "+12 yards", "Loss of 3", "No gain"
const gainHeadline = (g) => (g > 0 ? `+${plural(g, 'yard')}` : g < 0 ? `Loss of ${-g}` : 'No gain');

/**
 * Build the log entry for a resolved event (live game).
 * @param {import('./data.js').Library} lib
 * @param {object} spot the spot file (team names and lineups)
 * @param {object} ev resolve event
 * @param {object} before state before the event
 * @param {object} after state after the event
 * @returns {object} log entry (see ENGINE.md "Log entries")
 */
export function describe(lib, spot, ev, before, after) {
  const teams = before.teams;
  const team = ev.team;
  const abbr = teams[team];
  const opp = teams[other(team)];
  const roster = spot.players?.[abbr] || {};
  const defRoster = spot.players?.[opp] || {};
  const entry = {
    type: ev.type,
    team,
    text: '',
    headline: '',
    qtr: ev.qtr0,
    clockBefore: ev.clock0,
    clockAfter: after.phase === 'done' ? 0 : after.clock,
    qtrAfter: after.qtr,
    pre: ev.pre.map((p) => preText(p, teams)),
    state: after,
  };
  const scoreChange = after.score[0] !== before.score[0] || after.score[1] !== before.score[1];
  switch (ev.type) {
    case 'expired':
      entry.headline = 'Time runs out';
      entry.text = 'Time runs out before the snap';
      break;
    case 'kneel':
      entry.headline = 'Kneel';
      entry.text = `${nameOf(pickPlayer(roster.off, ['QB'], 1), abbr)} kneels`;
      entry.anim = { kind: 'kneel', fromYl: ev.yl0, toYl: ev.yl0 + 1, yards: -1 };
      break;
    case 'spike':
      entry.headline = 'Spike';
      entry.text = `${nameOf(pickPlayer(roster.off, ['QB'], 1), abbr)} spikes it to stop the clock`;
      entry.anim = { kind: 'spike', fromYl: ev.yl0, toYl: ev.yl0, yards: 0 };
      break;
    case 'play':
      Object.assign(entry, describePlay(lib, ev, roster, defRoster, abbr));
      break;
    case 'fg': {
      const f = ev.fg;
      const kicker = roster.k;
      entry.headline = f.roughing ? 'Flag: roughing the kicker' : f.blocked ? 'Blocked!' : f.made ? 'Field goal is good' : 'No good';
      entry.text = `${nameOf(kicker, abbr)} ${f.dist}-yard field goal${f.fire ? ' (rushed)' : ''}: `
        + (f.blocked ? `blocked${f.retTd ? ', returned for a touchdown' : ''}` : f.made ? 'good' : 'no good')
        + (f.roughing ? `. Roughing the kicker on ${opp}: 15 yards and a first down` : '');
      entry.fg = { ...f };
      entry.players = { kicker: playerRef(kicker) };
      entry.anim = { kind: 'fg', fromYl: ev.yl0, dist: f.dist, made: f.made, blocked: f.blocked };
      break;
    }
    case 'punt': {
      const p = ev.punt;
      entry.headline = p.roughing ? 'Flag: roughing the punter' : p.blocked ? 'Punt blocked!' : p.retTd ? 'Punt return touchdown' : p.touchback ? 'Touchback' : `Punt, net ${p.net}`;
      entry.text = `${nameOf(roster.p, abbr)} punts`
        + (p.roughing ? `: roughing the punter on ${opp}, 15 yards and a first down`
          : p.blocked ? `: blocked${p.retTd ? ' and returned for a touchdown' : ''}`
            : p.retTd ? `: returned for a touchdown by ${opp}`
              : p.kickRec ? `: muffed, recovered by ${abbr}`
                : p.touchback ? ', touchback' : `, net ${plural(p.net, 'yard')}`);
      entry.punt = { ...p };
      entry.players = { punter: playerRef(roster.p) };
      entry.anim = { kind: 'punt', fromYl: ev.yl0, recvYl: p.recvYl, net: p.net };
      break;
    }
    case 'kickoff': {
      const k = ev.ko;
      const recv = opp;
      if (ev.onside) {
        entry.headline = k.kickRec ? 'Onside kick recovered!' : 'Onside kick: they recover';
        entry.text = `Onside kick, recovered by ${k.kickRec ? abbr : recv}`;
      } else if (k.retTd) {
        entry.headline = 'Kick return touchdown';
        entry.text = `${ev.free ? 'Free kick' : 'Kickoff'} returned for a touchdown by ${recv}`;
      } else if (k.kickRec) {
        entry.headline = 'Kicking team recovers';
        entry.text = `${ev.free ? 'Free kick' : 'Kickoff'} muffed, recovered by ${abbr}`;
      } else {
        const own = 100 - k.recvYl;
        entry.headline = k.touchback ? 'Touchback' : `${recv} ball at the ${own <= 50 ? `${recv} ${own}` : `${abbr} ${100 - own}`}`;
        entry.text = `${ev.free ? 'Free kick' : 'Kickoff'}${k.touchback ? ', touchback' : ''}: ${recv} start at ${own <= 50 ? `their own ${own}` : `the ${abbr} ${100 - own}`}`;
      }
      entry.kick = { onside: ev.onside, recovered: !!k.kickRec, retTd: !!k.retTd, recvYl: k.recvYl, touchback: !!k.touchback, free: !!ev.free };
      entry.anim = { kind: ev.onside ? 'onside' : 'kickoff', recvYl: k.recvYl };
      break;
    }
    case 'xp':
      entry.headline = ev.good ? 'Extra point is good' : 'Extra point no good';
      entry.text = `${nameOf(roster.k, abbr)} extra point: ${ev.good ? 'good' : 'no good'}`;
      entry.anim = { kind: 'xp', made: ev.good };
      break;
    case 'two': {
      const call = lib.calls[ev.call];
      entry.headline = ev.good ? 'Two-point try good' : 'Two-point try fails';
      entry.text = `Two-point try (${call.label}): ${ev.good ? 'good' : 'no good'}`;
      entry.call = call.id;
      entry.real = lib.provenance(ev.out.play);
      entry.anim = { kind: lib.isPass[ev.call] ? 'pass' : 'run', made: ev.good };
      break;
    }
    case 'timeout':
      entry.headline = 'Timeout';
      entry.text = `Timeout, ${abbr} (${plural(after.to[team], 'timeout')} left)`;
      break;
    default:
      break;
  }
  entry.post = postNotes(ev, before, after);
  entry.score = scoreChange;
  return entry;
}

function preText(p, teams) {
  if (p.type === 'timeout') return { ...p, text: `Timeout, ${teams[p.team]}${p.why === 'kick' ? ' (to set up the kick)' : ''}` };
  if (p.stop === '2mw') return { ...p, text: 'Two-minute warning' };
  return { ...p, text: p.secs >= 3 ? `Clock runs ${Math.round(p.secs)} seconds` : '' };
}

function postNotes(ev, before, after) {
  const notes = [];
  if (ev.warning) notes.push('Two-minute warning');
  if (ev.untimed) notes.push('Untimed down: the half cannot end on a defensive foul');
  if (after.phase === 'done') {
    if (before.endAtHalf && after.winner === null) notes.push('Halftime');
    else notes.push(after.qtr >= 5 ? 'End of overtime' : 'Final');
  } else if (after.qtr !== before.qtr) {
    if (after.qtr === 3) notes.push('Halftime');
    else if (after.qtr === 5 && before.qtr === 4) notes.push('End of regulation: overtime');
    else if (after.qtr > 5) notes.push('End of the period, still tied');
    else notes.push('End of the quarter');
  }
  return notes;
}

function describePlay(lib, ev, roster, defRoster, abbr) {
  const o = ev.out;
  const i = o.play;
  const call = lib.calls[ev.call];
  const fl = lib.fl[i];
  const h = (lib.pid[i] * 2654435761) >>> 0;
  const qb = pickPlayer(roster.off, ['QB'], h);
  const tgtGroup = PLAYER_GROUPS[Math.min(4, Math.max(0, lib.tgt[i]))];
  const isPass = !!lib.isPass[ev.call] || !!(fl & (FL.SACK | FL.SCRAMBLE));
  const scramble = !!(fl & FL.SCRAMBLE);
  const sack = !!(fl & FL.SACK);
  const carrierPlayer = scramble ? qb : pickPlayer(roster.off, tgtGroup, h >>> 3);
  const defGroups = sack ? ['DL', 'LB'] : fl & FL.INT ? ['DB', 'LB'] : isPass ? ['DB', 'LB'] : ['LB', 'DL', 'DB'];
  const defender = pickPlayer(defRoster.def, defGroups, h >>> 7);
  const qbName = nameOf(qb, abbr);
  const who = nameOf(carrierPlayer, abbr);
  const dname = nameOf(defender, 'the defense');
  const g = o.gain;
  let text;
  let headline;
  if (o.noPlay) {
    text = `Flag: ${g >= 0 ? 'penalty on the defense' : `penalty on ${abbr}`}, ${g >= 0 ? '+' : '\u2212'}${plural(Math.abs(g), 'yard')}${o.auto1 ? ', automatic first down' : ''}`;
    headline = 'Flag';
  } else if (sack) {
    text = `${qbName} is sacked by ${dname}: ${yardsText(g)}`;
    headline = g < 0 ? `Sacked, \u2212${-g}` : 'Sacked, no loss';
  } else if (scramble) {
    text = `${qbName} scrambles: ${yardsText(g)}`;
    headline = gainHeadline(g);
  } else if (isPass && o.inc && !o.tov) {
    text = `${qbName} ${call.say}: incomplete, intended for ${who}`;
    headline = 'Incomplete';
  } else if (isPass) {
    text = `${qbName} ${call.say}${o.tov ? '' : ` to ${who}: ${yardsText(g)}`}`;
    headline = gainHeadline(g);
  } else {
    text = `${who} ${call.say}: ${yardsText(g)}`;
    headline = gainHeadline(g);
  }
  if (o.tov) {
    if (fl & FL.INT) {
      text += `: intercepted by ${dname}${o.defTd ? ' and returned for a touchdown' : ''}`;
      headline = o.defTd ? 'Pick-six' : 'Intercepted';
    } else {
      text += `: fumble, recovered by the defense${o.defTd ? ' and returned for a touchdown' : ''}`;
      headline = o.defTd ? 'Defensive touchdown' : 'Fumble lost';
    }
  } else if (o.td) {
    text = text.replace(/: [^:]*$/, `: ${g}-yard touchdown`);
    headline = 'Touchdown!';
  } else if (o.safety) {
    text += ', safety';
    headline = 'Safety';
  }
  const extras = [];
  if (o.pen && !o.noPlay) extras.push('with a penalty');
  if (o.oob && !o.td && !o.tov) extras.push('out of bounds');
  else if (ev.oobTry && !o.td && !o.tov && !o.inc && !o.noPlay) extras.push('could not get out of bounds');
  if (ev.first && !o.td) extras.push(o.auto1 ? 'automatic first down' : 'first down');
  if (ev.downs) extras.push('turnover on downs');
  if (extras.length) text += `, ${extras.join(', ')}`;
  return {
    call: call.id,
    callLabel: call.label,
    look: ev.look >= 0 ? LOOKS[ev.look] : null,
    matchup: ev.matchup,
    headline,
    text,
    yards: g,
    first: !!ev.first,
    turnover: !!o.tov || !!ev.downs,
    flags: fl,
    real: lib.provenance(i),
    players: {
      passer: isPass ? playerRef(qb) : null,
      target: isPass && !sack && !scramble ? playerRef(carrierPlayer) : null,
      carrier: !isPass || scramble ? playerRef(carrierPlayer) : null,
      defender: playerRef(defender),
    },
    anim: {
      kind: sack ? 'sack' : scramble ? 'scramble' : o.noPlay ? 'penalty' : isPass ? 'pass' : 'run',
      fromYl: ev.yl0,
      toYl: Math.min(100, Math.max(0, ev.yl0 - g)),
      yards: g,
      air: lib.air[i],
      loc: LOC_NAMES[lib.loc[i]] || 'middle',
      carrierPos: ['QB', 'RB', 'WR', 'TE', 'OTHER'][Math.min(4, Math.max(0, lib.tgt[i]))],
      complete: isPass && !o.inc && !sack && !scramble && !o.tov && !o.noPlay,
      inc: !!o.inc,
      oob: !!o.oob,
      td: !!o.td,
      int: !!(fl & FL.INT),
      fumble: !!(fl & FL.FUM),
      defTd: !!o.defTd,
      penalty: !!o.pen,
      dur: o.dur,
    },
  };
}
