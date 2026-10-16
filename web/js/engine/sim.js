// Monte Carlo rest-of-game simulation.
//
// `evaluate` plays the rest of the game `n` times after each option, with the policy
// calling every later snap for both teams, and returns the user's average result (win 1,
// tie 0.5, loss 0; first-half spots stop at halftime and score special.halftime_wp).
//
// Common random numbers: every uniform is addressed by (seed, run r, event e, slot), where
// the slot names its purpose (rng.js SLOT), whichever option is being evaluated and
// whichever worker runs it. Two options are therefore compared on the same random futures
// (the same real play is drawn for the same purpose even if one option skips a draw), and
// splitting the work across workers (by option or by run) gives exactly the same numbers.

import { Draws } from './rng.js';
import { callTimeout, marginFor, other } from './rules.js';
import { resolveKickoff, resolvePat, resolveSnap, spreadFor } from './resolve.js';
import { defenseTimeout, kickoffAction, offenseAction, patAction } from './policy.js';

export const MAX_EVENTS = 400;        // hard cap on events per simulated game
const NO_DEFENSE = { look: -1, block: false };

/**
 * One event played by the policy for whichever team acts.
 * @returns {object} the new state
 */
export function policyStep(lib, ctx, s, dr) {
  if (s.phase === 'pat') return resolvePat(lib, ctx, s, patAction(lib, ctx, s, dr), dr).state;
  if (s.phase === 'kickoff') return resolveKickoff(lib, ctx, s, kickoffAction(lib, ctx, s), dr).state;
  let t = s;
  if (defenseTimeout(lib, ctx, t)) t = callTimeout(t, other(t.pos));
  return resolveSnap(lib, ctx, t, offenseAction(lib, ctx, t, dr), NO_DEFENSE, dr).state;
}

/**
 * Apply an option (the decision being evaluated) as the first event.
 * Option shapes (internal, call indices):
 *   {kind: 'offense', a: offense action, look}            the user's snap against a shown look
 *   {kind: 'defense', look, timeout, fourth}              the opponent's snap against the user's call
 *   {kind: 'kick_defense', a: opponent kick, block, timeout}
 *   {kind: 'pat', a: {kind: 'xp'|'two', call}}
 *   {kind: 'kickoff', onside}
 *   {kind: 'policy'}                                      no decision: the policy plays on
 */
export function applyOption(lib, ctx, s, opt, dr) {
  switch (opt.kind) {
    case 'offense':
      return resolveSnap(lib, ctx, s, opt.a, { look: opt.look ?? -1, block: false }, dr).state;
    case 'defense': {
      const t = opt.timeout ? callTimeout(s, other(s.pos)) : s;
      const a = offenseAction(lib, ctx, t, dr, { fourth: opt.fourth, look: opt.look });
      return resolveSnap(lib, ctx, t, a, { look: opt.look, block: false }, dr).state;
    }
    case 'kick_defense': {
      const t = opt.timeout ? callTimeout(s, other(s.pos)) : s;
      return resolveSnap(lib, ctx, t, opt.a, { look: -1, block: !!opt.block }, dr).state;
    }
    case 'pat':
      return resolvePat(lib, ctx, s, opt.a, dr).state;
    case 'kickoff':
      return resolveKickoff(lib, ctx, s, { onside: !!opt.onside }, dr).state;
    default:
      return s.phase === 'done' ? s : policyStep(lib, ctx, s, dr);
  }
}

/**
 * The user's result in a finished (or capped) simulated game.
 * @returns {number} 1 win, 0.5 tie, 0 loss; halftime win probability for first-half spots
 */
export function outcomeValue(lib, ctx, s) {
  const user = ctx.user;
  if (s.phase === 'done') {
    if (s.winner === null) {
      return lib.halftimeWp(marginFor(s, user), s.receive2h === user ? 1 : 0, spreadFor(ctx, user));
    }
    return s.winner === user ? 1 : s.winner === -1 ? 0.5 : 0;
  }
  const m = marginFor(s, user);
  return m > 0 ? 1 : m < 0 ? 0 : 0.5;
}

/** Play one run (`r`) of an option to the end and return the user's result. */
export function runOnce(lib, ctx, s0, opt, seed, r, dr = new Draws(seed)) {
  dr.seed = seed >>> 0;
  let s = applyOption(lib, ctx, s0, opt, dr.set(r, 0));
  let e = 1;
  while (s.phase !== 'done' && e < MAX_EVENTS) s = policyStep(lib, ctx, s, dr.set(r, e++));
  return outcomeValue(lib, ctx, s);
}

/**
 * Evaluate options by simulation with common random numbers.
 * @param {import('./data.js').Library} lib
 * @param {object} ctx buildContext()
 * @param {object} state the state before the decision
 * @param {object[]} options internal options (see applyOption)
 * @param {{n?: number, seed?: number, start?: number}} [o] runs `start .. start+n-1`
 * @returns {Float64Array} the sum of the user's results over the runs, per option
 */
export function evaluateSums(lib, ctx, state, options, { n = 400, seed = 1, start = 0 } = {}) {
  const sums = new Float64Array(options.length);
  const dr = new Draws(seed);
  for (let j = 0; j < options.length; j++) {
    let sum = 0;
    for (let r = start; r < start + n; r++) sum += runOnce(lib, ctx, state, options[j], seed, r, dr);
    sums[j] = sum;
  }
  return sums;
}

/**
 * Evaluate options and return the user's win chance after each (mean over `n` runs).
 * @returns {Float64Array}
 */
export function evaluate(lib, ctx, state, options, { n = 400, seed = 1 } = {}) {
  const sums = evaluateSums(lib, ctx, state, options, { n, seed });
  return sums.map((v) => v / n);
}
