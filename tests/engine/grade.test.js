import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREQUENCY_ONLY, N_COACHES, addMeasures, choiceProbs, coachBetas, emptyMeasures, gradeOf, lookalike, percentile, typicalAt,
} from '../../web/js/engine/grade.js';
import { makeCoaches } from '../fixtures/synth.js';

test('grade thresholds in win-chance points', () => {
  const g = (d) => `${gradeOf(d).color}${gradeOf(d).symbol}`;
  assert.equal(g(0), 'green✓');
  assert.equal(g(0.5), 'green✓');
  assert.equal(g(0.51), 'yellow≈');
  assert.equal(g(2), 'yellow≈');
  assert.equal(g(2.01), 'orange!');
  assert.equal(g(5), 'orange!');
  assert.equal(g(5.01), 'red✗');
  assert.equal(g(60), 'red✗');
});

test('simulated coaches: 15% follow NFL habits only, the rest sharpen by skill', () => {
  const b = coachBetas();
  assert.equal(b.length, N_COACHES);
  const zeros = b.filter((x) => x === 0).length;
  assert.equal(zeros, Math.round(FREQUENCY_ONLY * N_COACHES));
  for (const x of b) if (x) assert.ok(x >= 1 / 0.3 - 1e-6 && x <= 1 / 0.003 + 1e-6);
  const d = { wp: [0.5, 0.45], q: [0.1, 0.9], best: 0.5 };
  assert.deepEqual(choiceProbs(d, 0).map((p) => +p.toFixed(6)), [0.1, 0.9]);
  assert.ok(choiceProbs(d, 300)[0] > 0.99, 'a sharp coach finds the best option');
});

const decisions = [
  { wp: [0.52, 0.5, 0.45, 0.4], q: [0.2, 0.4, 0.3, 0.1], best: 0.52 },
  { wp: [0.6, 0.58, 0.5], q: [0.3, 0.5, 0.2], best: 0.6 },
  { wp: [0.7, 0.62], q: [0.4, 0.6], best: 0.7 },
];
const pick = (i) => decisions.map((d) => ({ ...d, chosen: d.wp[Math.min(i, d.wp.length - 1)] }));

test('percentile falls as the player loses more win chance', () => {
  let prev = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = percentile(pick(i), 5);
    assert.ok(p <= prev, `choice ${i}: ${p} > ${prev}`);
    assert.ok(p >= 0 && p <= 100);
    prev = p;
  }
  assert.ok(percentile(pick(0), 5) > 60, 'a perfect game beats most coaches');
  assert.ok(percentile(pick(3), 5) < 10);
  assert.equal(percentile(pick(1), 5), percentile(pick(1), 5), 'deterministic for a seed');
  assert.equal(percentile([{ wp: [0.5], q: [1], best: 0.5, chosen: 0.5 }], 1), null, 'nothing to grade');
  assert.equal(percentile([{ wp: [0.5, 0.5], q: [0.5, 0.5], best: 0.5, chosen: 0.5 }], 1), 50, 'everyone ties');
  const near = [{ wp: [0.5, 0.497], q: [0.5, 0.5], best: 0.5, chosen: 0.497 }];
  assert.equal(percentile(near, 1), 50, 'a loss inside the green band is forgiven');
});

test('typical play-caller: expected win chance and loss at NFL frequencies', () => {
  const t = typicalAt(decisions[2]);
  assert.ok(Math.abs(t.wp - (0.4 * 0.7 + 0.6 * 0.62)) < 1e-12);
  assert.ok(Math.abs(t.cost - 0.048) < 1e-12);
});

test('look-alike coach from accumulated measures', () => {
  const coaches = makeCoaches();
  const m = emptyMeasures();
  assert.equal(lookalike(coaches, m), null, 'no data, no look-alike');
  // A pass-happy, aggressive player: threw 9 of 10 where NFL callers would throw ~6.
  const passy = addMeasures(m, { pass: { n: 10, mine: 9, exp: 6 }, go: { n: 3, mine: 3, exp: 1 } });
  const a = lookalike(coaches, passy);
  assert.equal(a.coach.name, 'Air Raid');
  assert.ok(a.z.pass > 0);
  assert.ok(a.reasons.length >= 1);
  assert.match(a.reasons[0].text, /of/);
  const runner = addMeasures(m, { pass: { n: 10, mine: 2, exp: 6 }, go: { n: 3, mine: 0, exp: 1 } });
  assert.equal(lookalike(coaches, runner).coach.name, 'Ground Pound');
  const sum = addMeasures(passy, runner);
  assert.deepEqual(sum.pass, { n: 20, mine: 11, exp: 12 });
  assert.deepEqual(sum.deep, { n: 0, mine: 0, exp: 0 });
});
