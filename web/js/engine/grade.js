// Grades, the daily percentile against simulated play-callers, the "typical NFL
// play-caller" comparison and the head-coach look-alike.

import { Rng } from './rng.js';

/** Grade bands by win chance lost, in percentage points (upper bounds inclusive). */
export const GRADES = [
  { color: 'green', symbol: '✓', word: 'best', max: 0.5 },
  { color: 'yellow', symbol: '≈', word: 'close', max: 2 },
  { color: 'orange', symbol: '!', word: 'costly', max: 5 },
  { color: 'red', symbol: '✗', word: 'a big miss', max: Infinity },
];

/**
 * The grade band for a loss of win chance.
 * @param {number} delta percentage points lost (best minus chosen, >= 0)
 * @returns {{color: string, symbol: string, word: string, max: number}}
 */
export function gradeOf(delta) {
  return GRADES.find((g) => delta <= g.max + 1e-9);
}

export const N_COACHES = 4000;
export const FREQUENCY_ONLY = 0.15;     // share of simulated coaches who only follow NFL habits
export const TAU_RANGE = [0.003, 0.3];  // log-uniform "temperature" of the others
export const FORGIVE = 0.005;           // losses within the green band count as zero for the percentile

/**
 * Skill of the simulated coaches, stratified so that results are smooth and repeatable:
 * 15% call by NFL frequency only (beta = 0); the others sharpen the NFL frequencies by
 * exp(beta * win chance) with beta = 1/tau, tau log-uniform on [0.003, 0.3].
 * @returns {Float64Array} beta per coach
 */
export function coachBetas(n = N_COACHES) {
  const betas = new Float64Array(n);
  const [lo, hi] = TAU_RANGE.map(Math.log);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    if (u < FREQUENCY_ONLY) continue;
    const v = (u - FREQUENCY_ONLY) / (1 - FREQUENCY_ONLY);
    betas[i] = 1 / Math.exp(lo + v * (hi - lo));
  }
  return betas;
}

/**
 * One coach's option probabilities at a decision: q_i * exp(beta * (wp_i - best)).
 * @param {{wp: number[], q: number[], best: number}} d
 */
export function choiceProbs(d, beta) {
  const w = d.wp.map((wp, i) => (d.q[i] || 0) * Math.exp(beta * (wp - d.best)));
  const total = w.reduce((a, b) => a + b, 0);
  return total > 0 ? w.map((x) => x / total) : d.wp.map(() => 1 / d.wp.length);
}

/** Win chance lost at a decision, with losses inside the green band forgiven. */
const lost = (best, wp) => Math.max(0, best - wp - FORGIVE);

/**
 * Daily percentile: the share of simulated coaches whose total win chance lost over the
 * same decisions is larger than the player's (ties count half). Each simulated coach picks
 * one option per decision at random from `choiceProbs`. Losses within the green band
 * (FORGIVE) count as zero for everyone, so Monte Carlo noise between near-equal options
 * does not decide percentiles.
 * @param {{wp: number[], q: number[], best: number, chosen: number}[]} decisions win
 *   chances (0..1) of the graded options, their NFL frequencies, the best win chance and
 *   the player's
 * @param {number} seed
 * @returns {number|null} 0..100, or null when there was nothing to grade
 */
export function percentile(decisions, seed = 1) {
  const useful = decisions.filter((d) => d.wp.length >= 2);
  if (!useful.length) return null;
  const playerCost = useful.reduce((s, d) => s + lost(d.best, d.chosen), 0);
  const betas = coachBetas();
  const rng = new Rng(seed, 0x9e77);
  let score = 0;
  for (const beta of betas) {
    let cost = 0;
    for (const d of useful) {
      const p = choiceProbs(d, beta);
      let t = rng.float();
      let pick = p.length - 1;
      for (let i = 0; i < p.length; i++) {
        t -= p[i];
        if (t < 0) {
          pick = i;
          break;
        }
      }
      cost += lost(d.best, d.wp[pick]);
    }
    if (cost > playerCost + 1e-9) score += 1;
    else if (Math.abs(cost - playerCost) <= 1e-9) score += 0.5;
  }
  return (100 * score) / betas.length;
}

/**
 * The "typical NFL play-caller" at one decision (beta = 0: NFL frequencies only).
 * @returns {{wp: number, cost: number}} expected win chance and expected loss (0..1)
 */
export function typicalAt(d) {
  const total = d.q.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { wp: d.best, cost: 0 };
  let wp = 0;
  d.wp.forEach((v, i) => { wp += (d.q[i] / total) * v; });
  return { wp, cost: Math.max(0, d.best - wp) };
}

// ---------------------------------------------------------------------------------------
// Look-alike coach.

export const MEASURES = ['pass', 'deep', 'go', 'two'];
// coaches with fewer late-game snaps than this are too small a sample to be anyone's look-alike
export const MIN_COACH_SNAPS = 100;

/** Empty measure totals: per measure, decisions counted, the player's sum, the NFL-expected sum. */
export function emptyMeasures() {
  return Object.fromEntries(MEASURES.map((m) => [m, { n: 0, mine: 0, exp: 0 }]));
}

/** Add measure totals (e.g. today's game to the totals kept across days). Pure. */
export function addMeasures(a, b) {
  const out = emptyMeasures();
  for (const m of MEASURES) {
    for (const k of ['n', 'mine', 'exp']) out[m][k] = (a?.[m]?.[k] || 0) + (b?.[m]?.[k] || 0);
  }
  return out;
}

const PHRASES = {
  pass: ['threw on', 'plays', 'ran on'],
  deep: ['went deep on', 'throws', 'kept it short on'],
  go: ['went for it on', 'fourth downs', 'kicked on'],
  two: ['went for two', 'tries', 'kicked the extra point on'],
};

/**
 * Nearest real coach (coaches.json) to the player's tendencies. Each measure's z-score is
 * the player's average lean against what NFL play-callers would have done in the same
 * spots, shrunk by n/(n+1), over the league's spread of coach tendencies; a coach's z-score
 * is his rate against the league mean. Distance = sum of w * (z_player - z_coach)^2 with
 * w = n/(n+1), over the measures the player has data for.
 * @param {object} coachesJson coaches.json
 * @param {object} measures totals from emptyMeasures/addMeasures
 * @returns {null | {coach: object, distance: number, z: object, reasons: object[]}}
 */
export function lookalike(coachesJson, measures) {
  if (!coachesJson?.coaches?.length) return null;
  const league = coachesJson.league || {};
  const z = {};
  const w = {};
  for (const m of MEASURES) {
    const t = measures?.[m];
    const sd = league[m]?.sd;
    if (!t || !t.n || !(sd > 0)) continue;
    z[m] = (t.mine - t.exp) / (t.n + 1) / sd;
    w[m] = t.n / (t.n + 1);
  }
  const used = Object.keys(z);
  if (!used.length) return null;
  let best = null;
  for (const c of coachesJson.coaches) {
    if (!(c.n >= MIN_COACH_SNAPS)) continue;
    let dist = 0;
    let ok = false;
    for (const m of used) {
      if (!Number.isFinite(c[m]) || !(league[m]?.sd > 0)) continue;
      const zc = (c[m] - league[m].mean) / league[m].sd;
      dist += w[m] * (z[m] - zc) ** 2;
      ok = true;
    }
    if (ok && (!best || dist < best.distance)) best = { coach: c, distance: dist };
  }
  if (!best) return null;
  const reasons = [];
  for (const m of used) {
    const zc = (best.coach[m] - league[m].mean) / league[m].sd;
    if (Math.abs(z[m]) < 0.35 || Math.sign(z[m]) !== Math.sign(zc)) continue;
    const t = measures[m];
    const mine = Math.round(t.mine);
    const exp = Math.round(t.exp);
    if (mine === exp) continue;
    const [more, unit, less] = PHRASES[m];
    const text = z[m] > 0
      ? `${more} ${mine} of ${t.n} ${unit} (most play-callers: ${exp})`
      : `${less} ${t.n - mine} of ${t.n} ${unit} (most play-callers: ${t.n - exp})`;
    reasons.push({ measure: m, z: z[m], weight: w[m] * Math.abs(z[m]), text });
  }
  reasons.sort((a, b) => b.weight - a.weight);
  return { coach: best.coach, distance: best.distance, z, reasons: reasons.slice(0, 2) };
}
