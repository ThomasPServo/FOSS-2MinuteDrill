// The "average NFL play-caller": every decision the computer makes, for the opponent in the
// live game and for both teams in simulations.
//
// Play calls are sampled from the real NFL call mix of the situation (play counts in the
// library). Clock management, kneels, spikes, fourth downs, kicks to win, tries and onside
// kicks follow simple rules modelled on what NFL teams do. All functions are deterministic
// given the state and the random draws of the event (rng.js Draws).

import { MODE, gameMode, sitKey } from './data.js';
import { SLOT } from './rng.js';
import {
  canOnside, halfSeconds, hasTwoMinuteWarning, inStopWindow, isSecondHalf, marginFor, other, TWO_MINUTES,
} from './rules.js';
import { fgChance, matchupScore } from './resolve.js';

export const AUDIBLE = 0.5;           // offense "checks into" calls that beat a called defense

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Can the team with the ball run out the half by kneeling, whatever the defense does with
 * its timeouts? Kneels left before fourth down, ~39 s between snaps when the clock runs,
 * 1.5 s per kneel; each defensive timeout (and a pending two-minute warning) stops one gap.
 */
export function canKneelOut(s) {
  const def = other(s.pos);
  const k = clamp(4 - s.down, 0, 3);
  const gaps = k + (s.running ? 1 : 0);
  const stops = s.to[def] + (hasTwoMinuteWarning(s) && !s.warned && s.clock > TWO_MINUTES ? 1 : 0);
  const burn = k * 1.5 + Math.max(gaps - stops, 0) * 39 + Math.min(gaps, stops);
  return halfSeconds(s) <= burn + 1;
}

/**
 * Is kneeling a sensible option to offer the player? Never on fourth down; first half when
 * not trailing with 2:00 or less; second half when leading and close to running it out.
 */
export function kneelOffered(s) {
  if (s.down >= 4) return false;
  const hs = halfSeconds(s);
  const m = marginFor(s, s.pos);
  if (!isSecondHalf(s)) return m >= 0 && hs <= 120;
  const k = 5 - s.down - s.to[other(s.pos)] - (s.running ? 0 : 1);
  return m > 0 && hs <= 40 * Math.max(k, 0) + 30;
}

/** Clock situation of the offense, shared by the policy's decisions. */
function outlook(lib, ctx, s) {
  const team = s.pos;
  const hs = halfSeconds(s);
  const h2 = isSecondHalf(s);
  const m = marginFor(s, team);
  const myTO = s.to[team];
  const fgP = fgChance(lib, ctx, team, s.yl);
  const fgUseful = !h2 || (m >= -3 && m <= 0);
  const closing = h2 && m >= -2 && m <= 0 && hs <= 180 && myTO > 0 && fgP >= 0.5;
  const attempt = h2 || s.yl - 35 <= 0.6 * (hs + 20 * myTO);
  const runOut = !h2 && !attempt && hs <= 120;
  const aware = (h2 ? m >= -16 && m <= 0 : attempt) && !closing;
  return { team, hs, h2, m, myTO, fgP, fgUseful, closing, attempt, runOut, aware };
}

/** The policy's tempo for the offense: 'hurry', 'normal' or 'milk'. */
export function usualTempo(lib, ctx, s) {
  return tempoOf(outlook(lib, ctx, s), s);
}

function tempoOf(o, s) {
  if (o.h2) {
    const hurry = ((o.m < 0 && o.hs <= 300) || (o.m <= -9 && o.hs <= 600) || (o.m === 0 && s.yl <= 80 && o.hs <= 75)) && !o.closing;
    if (hurry) return 'hurry';
    if ((o.m > 0 && o.hs <= 600) || (o.m === 0 && o.hs <= 240) || o.closing) return 'milk';
    return 'normal';
  }
  if (o.hs <= 120) return o.attempt ? 'hurry' : 'milk';
  return 'normal';
}

/**
 * Sample a call index from the NFL mix of a situation.
 * @param {number} key situation key
 * @param {number} u uniform draw
 * @param {0|1|2} only 0 any call, 1 runs only, 2 passes only (never the Hail Mary)
 * @param {number} look defensive look the offense sees (-1 none): tilts toward calls that beat it
 */
export function sampleCall(lib, key, u, only = 0, look = -1) {
  const mix = lib.mix(key);
  if (only === 0 && look < 0) {
    const t = u * mix.total;
    for (let c = 0; c < lib.nCalls; c++) if (mix.cum[c] > t && c !== lib.hail) return c;
    return lib.nCalls - 1 === lib.hail ? lib.nCalls - 2 : lib.nCalls - 1;
  }
  let total = 0;
  const w = new Float64Array(lib.nCalls);
  for (let c = 0; c < lib.nCalls; c++) {
    if (c === lib.hail || (only === 1 && lib.isPass[c]) || (only === 2 && !lib.isPass[c])) continue;
    w[c] = mix.freq[c] * (look >= 0 ? Math.exp(AUDIBLE * matchupScore(lib, c, look, key)) : 1);
    total += w[c];
  }
  if (total <= 0) return sampleCall(lib, key, u, 0, -1);
  let t = u * total;
  for (let c = 0; c < lib.nCalls; c++) {
    t -= w[c];
    if (t < 0 && w[c] > 0) return c;
  }
  for (let c = lib.nCalls - 1; c >= 0; c--) if (w[c] > 0) return c;
  return 0;
}

/**
 * Inputs of the special.fourth model, computed exactly as pipeline/models.py defines them.
 */
function fourthFeatures(s, o) {
  const yl = s.yl;
  const gsl = s.qtr >= 5 ? 0 : (4 - s.qtr) * 900 + s.clock;
  const margin = clamp(o.m, -21, 21) / 7;
  const timeLeft = gsl / 3600;
  const late = (s.qtr === 4 && gsl <= 600) || (s.qtr >= 5 && o.hs <= 600);
  return {
    const: 1,
    yl: yl / 10,
    yl_sq: (yl / 10) ** 2,
    log_ytg: Math.log(Math.max(1, s.ytg)),
    fg_long: Math.max(0, yl + 18 - 45) / 10,
    margin,
    time_left: timeLeft,
    margin_late: margin * (1 - timeLeft),
    trail_late: late && o.m < 0 ? 1 : 0,
    need_td: late && o.m <= -4 ? 1 : 0,
    lead_late: late && o.m > 0 ? 1 : 0,
    half_end: s.qtr === 2 && o.hs <= 120 ? 1 : 0,
  };
}

/**
 * Fourth-down choice: 'go', 'fg' or 'punt'. Forced choices first (trailing late with a
 * field goal that does not help, a kick that wins or ties as time runs out, overtime), then
 * the special.fourth model of what NFL teams do.
 */
export function fourthDown(lib, ctx, s, u) {
  return fourthChoice(lib, ctx, s, outlook(lib, ctx, s), u);
}

function fourthChoice(lib, ctx, s, o, u) {
  const { m, hs, fgP } = o;
  if (s.qtr >= 5 && s.ot && s.ot.done[other(s.pos)] >= 1) {
    if (m <= -4) return 'go';
    if (m < 0) return fgP >= 0.3 ? 'fg' : 'go';
    if (m === 0 && fgP >= 0.5) return 'fg';
  }
  if (o.h2) {
    if (hs <= 40) {
      if (m < -3) return 'go';
      if (m <= 0 && fgP >= 0.3) return 'fg';
      if (m < 0) return 'go';
      if (m === 0 && s.yl >= 35) return 'punt';
    }
    if (s.qtr >= 4 && ((m < -3 && hs <= 150) || (m <= -9 && hs <= 300))) return 'go';
    if (m === 0 && fgP < 0.3 && s.yl >= 50 && hs <= 120) return 'punt';
  } else if (hs <= 20) {
    if (fgP >= 0.2) return 'fg';
  }
  let choice = modelChoice(lib, s, o, ctx, u);
  if (choice === 'punt' && s.yl < 30) choice = fgP >= 0.3 ? 'fg' : 'go';
  if (choice === 'fg' && fgP < 0.02) choice = s.yl >= 40 ? 'punt' : 'go';
  if (!o.h2 && hs <= 20 && choice === 'punt' && s.yl < 60) choice = 'go';
  return choice;
}

/**
 * NFL fourth-down choice probabilities {go, fg, punt} from special.fourth for the team with
 * the ball, or null when the data has no usable model.
 */
export function fourthProbs(lib, ctx, s) {
  return lib.fourthProbs(fourthFeatures(s, outlook(lib, ctx, s)));
}

function modelChoice(lib, s, o, ctx, u) {
  const p = lib.fourthProbs(fourthFeatures(s, o));
  if (p) {
    if (u < p.go) return 'go';
    return u < p.go + p.fg ? 'fg' : 'punt';
  }
  // Fallback when no model is available: roughly what NFL teams did in the 2020s.
  const ytg = s.ytg;
  if (o.fgP >= 0.55 && !(ytg <= 1 && s.yl <= 5)) return u < 0.12 && ytg <= 2 ? 'go' : 'fg';
  if (s.yl >= 40) return ytg <= 1 && s.yl <= 60 && u < 0.5 ? 'go' : 'punt';
  if (ytg <= 3) return 'go';
  return o.fgP >= 0.3 ? 'fg' : 'go';
}

/**
 * The offense's action for the next snap (state in phase 'snap').
 * @param {import('./data.js').Library} lib
 * @param {object} ctx
 * @param {object} s
 * @param {import('./rng.js').Draws} dr random draws of this event
 * @param {{fourth?: 'go'|'fg'|'punt', look?: number}} [opts] force the fourth-down choice;
 *   the look of the defense (the offense audibles against it)
 * @returns {object} internal action
 */
export function offenseAction(lib, ctx, s, dr, opts = {}) {
  const o = outlook(lib, ctx, s);
  const uCall = dr.u(SLOT.CALL);
  const u4 = dr.u(SLOT.FOURTH);
  const tempo = tempoOf(o, s);
  const timeout = s.running && o.myTO > 0 && (o.h2
    ? !o.closing && ((o.m <= 0 && (o.hs <= 60 || (o.m <= -9 && o.hs <= 120))) || (o.fgP >= 0.35 && o.fgUseful && o.hs <= 25))
    : o.attempt && o.hs <= 30 + 15 * o.myTO && o.hs <= 75);

  // Run out the clock.
  const kneelOk = o.h2 ? o.m > 0 || (o.m === 0 && s.yl >= 70 && o.hs <= 40) : o.runOut;
  if (kneelOk && opts.fourth !== 'go' && canKneelOut(s)) return { type: 'kneel', tempo: 'milk', timeout: false };

  // Last play of the half: kick if it helps.
  const lastPlay = o.hs <= 6;
  const budget = o.myTO > 0 ? 8 : 15;
  const fgLast = (lastPlay && o.fgP >= 0.08 && o.fgUseful) || (o.hs <= budget && o.fgP >= 0.3 && o.fgUseful && !s.running);
  const forced = opts.fourth;
  if (!forced && fgLast) return { type: 'fg', timeout: s.running && o.myTO > 0, tempo };
  // Kick to win: run the clock down to 0:03, call the timeout and kick.
  if (!forced && o.closing && s.running && o.hs <= 45 && o.myTO > 0) return { type: 'fg', rundown: true, timeout: true, tempo: 'milk' };

  // Spike to stop the clock.
  const spike = s.running && o.myTO === 0 && s.down <= 3 && !forced
    && ((tempo === 'hurry' && o.hs <= 35) || (o.h2 && o.fgP >= 0.35 && o.fgUseful && o.hs <= 22));
  if (spike) return { type: 'spike' };

  // Fire drill on fourth down.
  if (!forced && s.down === 4 && s.running && o.fgUseful && o.fgP >= 0.3 && o.hs <= 25) {
    return { type: 'fg', timeout: false, tempo: 'hurry' };
  }

  if (s.down === 4) {
    const choice = forced || fourthChoice(lib, ctx, s, o, u4);
    if (choice === 'fg') return { type: 'fg', timeout, tempo };
    if (choice === 'punt') return { type: 'punt', timeout: false, tempo };
  }

  const mode = o.closing ? MODE.KILL : gameMode(o.h2, o.hs, o.m);
  const key = sitKey(mode, s.down, s.ytg, s.yl);
  const look = opts.look ?? -1;
  let call;
  const needTd = o.h2 ? o.m < -3 && o.m >= -8 : o.fgP < 0.15;
  if (o.hs <= 10 && s.yl > 40 && needTd && lib.hail >= 0) call = lib.hail;
  else if (lastPlay && needTd) call = sampleCall(lib, key, uCall, 2, look);
  else if (o.runOut || (o.closing && s.down < 4)) call = sampleCall(lib, key, uCall, 1, look);
  else call = sampleCall(lib, key, uCall, 0, look);
  const oob = o.aware && o.myTO === 0 && inStopWindow(s);
  return { type: 'play', call, tempo, timeout, oob, keep: o.closing ? 12 : 0 };
}

/**
 * Does the defense call a timeout before the next snap? Late in the half, to save time for
 * its own possession: trailing (or protecting a tie or small lead against an offense in
 * field-goal range); in the first half, when the offense is running out the clock.
 */
export function defenseTimeout(lib, ctx, s) {
  if (!s.running || s.phase !== 'snap') return false;
  const def = other(s.pos);
  if (s.to[def] <= 0) return false;
  const hs = halfSeconds(s);
  const m = marginFor(s, s.pos);
  if (isSecondHalf(s)) {
    if (m > 0 && canKneelOut(s)) return false;
    if (m > 0 && (hs <= 240 || (m >= 9 && hs <= 420))) return true;
    return m >= -2 && m <= 0 && hs <= 120 && fgChance(lib, ctx, s.pos, s.yl) >= 0.5;
  }
  const o = outlook(lib, ctx, s);
  return o.runOut && !canKneelOut(s) && hs <= 100 && s.down >= 2;
}

/**
 * The try after a touchdown: two-point attempts by the NFL rate for the margin
 * (special.go2), with the obvious late-game chart choices forced.
 * @returns {{kind: 'xp'|'two', call?: number}}
 */
export function patAction(lib, ctx, s, dr) {
  const u = dr.u(SLOT.PAT);
  const uc = dr.u(SLOT.TWO_CALL);
  const m = marginFor(s, s.pos);
  const hs = halfSeconds(s);
  const late = isSecondHalf(s) && (s.qtr >= 5 || (s.qtr === 4 && hs <= 300));
  let two;
  if (late && (m === -2 || m === -5)) two = true;
  else if (late && (m === -1 || m === 0) && hs <= 0) two = m === 0 ? false : u < lib.go2Rate(m, true);
  else two = u < lib.go2Rate(m, late);
  if (!two) return { kind: 'xp' };
  const mix = lib.twoMix();
  const t = uc * mix.total;
  for (let c = 0; c < lib.nCalls; c++) if (mix.cum[c] > t) return { kind: 'two', call: c };
  return { kind: 'two', call: lib.callId('short_m') };
}

/** Kickoff: onside when trailing late and the ball is needed back (never on free kicks). */
export function kickoffAction(lib, ctx, s) {
  const k = s.kicker;
  if (s.free || !canOnside(s, k)) return { onside: false };
  const m = marginFor(s, k);
  const hs = halfSeconds(s);
  const onside = (hs <= 125 && s.to[k] <= 1) || hs <= 65 || (hs <= 160 && m <= -9);
  return { onside };
}
