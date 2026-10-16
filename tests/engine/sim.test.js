import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../../web/js/engine/rules.js';
import { buildContext } from '../../web/js/engine/resolve.js';
import { MAX_EVENTS, evaluate, evaluateSums, outcomeValue, runOnce } from '../../web/js/engine/sim.js';
import { Draws } from '../../web/js/engine/rng.js';
import { makeSpot, synthEngine } from '../fixtures/synth.js';

const { eng } = await synthEngine();
const lib = eng.lib;
const spot = makeSpot();
const ctx = buildContext(spot);
const s0 = initialState(spot);
const play = (id, tempo = 'hurry') => ({ kind: 'offense', a: { type: 'play', call: lib.callId(id), tempo, timeout: false, oob: false }, look: 0 });

test('common random numbers: same seed, same results, in any order or split', () => {
  const opts = [play('short_r'), play('run_middle'), play('deep_l')];
  const a = evaluate(lib, ctx, s0, opts, { n: 200, seed: 7 });
  const b = evaluate(lib, ctx, s0, [...opts].reverse(), { n: 200, seed: 7 });
  assert.deepEqual(Array.from(a), Array.from(b).reverse());
  const first = evaluateSums(lib, ctx, s0, opts, { n: 120, seed: 7, start: 0 });
  const rest = evaluateSums(lib, ctx, s0, opts, { n: 80, seed: 7, start: 120 });
  const whole = evaluateSums(lib, ctx, s0, opts, { n: 200, seed: 7 });
  whole.forEach((v, i) => assert.ok(Math.abs(v - first[i] - rest[i]) < 1e-9));
  const other = evaluate(lib, ctx, s0, opts, { n: 200, seed: 8 });
  assert.notDeepEqual(Array.from(a), Array.from(other));
});

test('common random numbers: the same option twice is identical, and clock twins share draws', () => {
  const hurry = play('short_r', 'hurry');
  const v = evaluate(lib, ctx, s0, [hurry, hurry], { n: 300, seed: 3 });
  assert.equal(v[0], v[1]);
  // With the clock stopped, tempo cannot matter: identical results run by run.
  const stopped = { ...s0, running: false };
  const w = evaluate(lib, ctx, stopped, [play('short_r', 'hurry'), play('short_r', 'milk')], { n: 300, seed: 3 });
  assert.equal(w[0], w[1]);
});

test('leading by 7 with the ball and 0:30 left is (almost) a sure win', () => {
  const s = { ...s0, score: [20, 27], clock: 30, down: 1, ytg: 10, yl: 70, to: [3, 3] };
  const [wp] = evaluate(lib, ctx, s, [{ kind: 'policy' }], { n: 400, seed: 1 });
  assert.ok(wp > 0.97, `wp ${wp}`);
});

test('trailing by 9 with 0:20 left is (almost) a sure loss', () => {
  const s = { ...s0, score: [29, 20], clock: 20, down: 1, ytg: 10, yl: 65 };
  const [wp] = evaluate(lib, ctx, s, [{ kind: 'policy' }], { n: 400, seed: 1 });
  assert.ok(wp < 0.03, `wp ${wp}`);
});

test('a tied game at the end of regulation goes to overtime, not a coin flip by fiat', () => {
  const s = { ...s0, score: [20, 20], clock: 2, down: 1, yl: 80, running: false };
  const [wp] = evaluate(lib, ctx, s, [{ kind: 'policy' }], { n: 400, seed: 2 });
  assert.ok(wp > 0.3 && wp < 0.7, `wp ${wp}`);
});

test('first-half spots end at halftime with the halftime model', () => {
  const half = initialState(makeSpot({ start: { qtr: 2, clock: 2, score: { KC: 14, NO: 7 }, yl: 90 } }));
  const s = { ...half, running: false };
  const [wp] = evaluate(lib, ctx, s, [{ kind: 'policy' }], { n: 50, seed: 4 });
  const expected = lib.halftimeWp(7, half.receive2h === 1 ? 1 : 0, -ctx.spread);
  assert.ok(Math.abs(wp - expected) < 0.03, `${wp} vs ${expected}`);
  const done = { ...s, phase: 'done', winner: null };
  assert.equal(outcomeValue(lib, ctx, done), expected);
  assert.equal(outcomeValue(lib, ctx, { ...s, phase: 'done', winner: 1 }), 1);
  assert.equal(outcomeValue(lib, ctx, { ...s, phase: 'done', winner: -1 }), 0.5);
});

test('every simulated game ends within the event cap', () => {
  const d = new Draws(1);
  for (let r = 0; r < 300; r++) {
    const s = { ...s0, qtr: 4, clock: 600, score: [20, 20], yl: 1 + (r % 99) };
    const v = runOnce(lib, ctx, s, { kind: 'policy' }, 99, r, d);
    assert.ok(v === 0 || v === 0.5 || v === 1);
  }
  assert.ok(MAX_EVENTS >= 200);
});

test('performance: 40 options x 400 runs of a two-minute drill well under 2 s', () => {
  const calls = lib.calls.filter((c) => c.family !== 'trick').map((c) => c.id);
  const opts = [];
  for (const id of calls) opts.push(play(id, 'hurry'));
  for (const id of calls.slice(0, 40 - opts.length)) opts.push(play(id, 'normal'));
  assert.equal(opts.length, 40);
  evaluate(lib, ctx, s0, opts.slice(0, 5), { n: 50, seed: 1 });   // warm up the caches
  const t = performance.now();
  evaluate(lib, ctx, s0, opts, { n: 400, seed: 11 });
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});
