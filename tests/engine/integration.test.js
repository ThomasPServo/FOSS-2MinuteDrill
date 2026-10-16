// Integration tests against the real data in web/data/ (skipped until the pipeline has
// written it). Whole games are played from real spots with arbitrary legal choices to
// catch crashes, NaNs and stuck states.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../web/js/engine/index.js';
import { Rng } from '../../web/js/engine/rng.js';
import { initialState } from '../../web/js/engine/rules.js';
import { buildContext } from '../../web/js/engine/resolve.js';
import { evaluate } from '../../web/js/engine/sim.js';

const DATA = fileURLToPath(new URL('../../web/data/', import.meta.url));
const ready = ['calls.json', 'plays.json', 'special.json', 'coaches.json', 'spots/index.json'].every((f) => existsSync(DATA + f));
const skip = ready ? false : 'web/data has not been built yet';
const fetchJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const FAST = { r1: 24, r2: 48, after: 24 };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

let engine = null;
const load = async () => (engine ||= await Engine.load(DATA, { fetchJson, workers: 0 }));

/** A random legal action for a decision. */
function randomAction(d, rng) {
  if (d.kind === 'auto') return { type: 'auto' };
  const o = d.options[rng.int(d.options.length)];
  const timeout = !!d.timeout?.available && rng.float() < 0.15;
  if (d.kind === 'offense') {
    const tempo = d.tempo ? d.tempo.choices[rng.int(3)] : undefined;
    const oob = !!d.oob.available && rng.float() < 0.3;
    return o.type === 'play' ? { type: 'play', call: o.call, tempo, timeout, oob } : { ...o, tempo, timeout };
  }
  return { ...o, timeout };
}

function checkState(s) {
  for (const k of ['qtr', 'clock', 'down', 'ytg', 'yl']) assert.ok(finite(s[k]), `${k} = ${s[k]}`);
  assert.ok(s.clock >= 0 && s.clock <= 900);
  assert.ok(s.yl >= 1 && s.yl <= 99);
  assert.ok(s.down >= 1 && s.down <= 4);
  assert.ok(s.ytg >= 1 && s.ytg <= 99);
  assert.ok(s.to.every((t) => t >= 0 && t <= 3));
  assert.ok(['snap', 'pat', 'kickoff', 'done'].includes(s.phase));
}

test('real data: library and schedule load', { skip }, async () => {
  const eng = await load();
  const lib = eng.lib;
  assert.equal(lib.nCalls, 26);
  assert.ok(lib.n > 50000);
  assert.ok(eng.spotIndex.daily.length > 0);
  const id = eng.dailySpotId('2026-10-16');
  assert.equal(id, eng.spotIndex.daily[0]);
  const spot = await eng.loadSpot(id);
  assert.equal(spot.id, id);
  const p = lib.fourthProbs({ const: 1, yl: 3.5, yl_sq: 12.25, log_ytg: Math.log(2), fg_long: 0.8, margin: 0, time_left: 0.5, margin_late: 0, trail_late: 0, need_td: 0, lead_late: 0, half_end: 0 });
  assert.ok(p && Math.abs(p.go + p.fg + p.punt - 1) < 1e-9, 'the fourth-down model uses the pipeline features');
  assert.ok(lib.fgProb(15, { indoor: true }) > 0.9 && lib.fgProb(42, { indoor: true }) < 0.65);
});

test('real data: simulation sanity', { skip }, async () => {
  const eng = await load();
  const spot = await eng.loadSpot(eng.spotIndex.daily[0]);
  const ctx = buildContext(spot);
  const s0 = initialState(spot);
  const u = s0.user;
  const lead = { ...s0, pos: u, score: u === 0 ? [27, 20] : [20, 27], qtr: 4, clock: 30, down: 1, ytg: 10, yl: 70, to: [3, 3], warned: true, phase: 'snap', endAtHalf: false };
  assert.ok(evaluate(eng.lib, ctx, lead, [{ kind: 'policy' }], { n: 400, seed: 1 })[0] > 0.97);
  const trail = { ...lead, score: u === 0 ? [20, 29] : [29, 20], clock: 20, yl: 65 };
  assert.ok(evaluate(eng.lib, ctx, trail, [{ kind: 'policy' }], { n: 400, seed: 1 })[0] < 0.03);
});

test('real data: 40 options x 400 runs of a two-minute drill well under 2 s', { skip }, async () => {
  const eng = await load();
  const lib = eng.lib;
  const id = eng.spotIndex.spots.find((s) => s.cat === 'drill').id;
  const spot = await eng.loadSpot(id);
  const ctx = buildContext(spot);
  const s0 = initialState(spot);
  const opts = [];
  for (let c = 0; opts.length < 40; c = (c + 1) % lib.nCalls) {
    if (lib.isTrick[c] || c === lib.hail) continue;
    opts.push({ kind: 'offense', a: { type: 'play', call: c, tempo: opts.length < 20 ? 'hurry' : 'normal', timeout: false, oob: opts.length >= 30 }, look: 0 });
  }
  evaluate(lib, ctx, s0, opts.slice(0, 4), { n: 50, seed: 1 });
  const t = performance.now();
  evaluate(lib, ctx, s0, opts, { n: 400, seed: 2 });
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test('real data: whole games with random legal choices end cleanly', { skip, timeout: 600000 }, async () => {
  const eng = await load();
  const idx = eng.spotIndex;
  const rng = new Rng(2026);
  const picks = [];
  for (const cat of Object.keys(idx.categories)) {
    const ids = idx.spots.filter((s) => s.cat === cat).map((s) => s.id);
    for (let k = 0; k < 4 && ids.length; k++) picks.push(ids[rng.int(ids.length)]);
  }
  for (const id of picks) {
    const spot = await eng.loadSpot(id);
    const game = eng.newGame(spot, { seed: rng.u32(), runs: FAST, mode: spot.cat === 'q4' ? 'survivor' : 'daily' });
    checkState(game.state);
    let acts = 0;
    while (!game.over) {
      assert.ok(acts++ < 400, `${id}: stuck after ${acts} actions`);
      const d = game.decision();
      assert.ok(['offense', 'defense', 'pat', 'kickoff', 'kick_defense', 'auto'].includes(d.kind));
      assert.ok(d.options.length >= 1);
      const r = await game.act(randomAction(d, rng));
      checkState(r.state);
      assert.ok(finite(r.wpBefore) && finite(r.wpAfter), `${id}: win chance`);
      assert.ok(r.wpAfter >= 0 && r.wpAfter <= 1);
      if (r.grade) {
        assert.ok(finite(r.grade.delta) && r.grade.delta >= 0);
        assert.ok(r.grade.options.every((o) => finite(o.wp) && finite(o.freq)));
      }
      for (const e of r.log) {
        assert.equal(typeof e.text, 'string');
        assert.ok(!/undefined|NaN|null/.test(e.text), `${id}: ${e.text}`);
      }
    }
    const s = game.summary();
    assert.ok(['win', 'loss', 'tie', 'half'].includes(s.result));
    if (spot.start.qtr <= 2) assert.equal(s.result, 'half');
    assert.ok(s.percentile === null || (s.percentile >= 0 && s.percentile <= 100));
    assert.ok(finite(s.cost) && finite(s.typical.wpa));
    assert.ok(finite(s.winChance));
    JSON.stringify(game.toJSON());
  }
});
