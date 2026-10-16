// Engine benchmark (not part of `node --test`): node tests/engine/bench.mjs
// Uses the real data in web/data/ when it exists, the synthetic fixture otherwise.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../web/js/engine/index.js';
import { initialState } from '../../web/js/engine/rules.js';
import { buildContext } from '../../web/js/engine/resolve.js';
import { evaluate } from '../../web/js/engine/sim.js';
import { makeDataFiles, memoryFetch } from '../fixtures/synth.js';

const DATA = fileURLToPath(new URL('../../web/data/', import.meta.url));
const real = existsSync(`${DATA}plays.json`) && existsSync(`${DATA}spots/index.json`);
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`;

let t = performance.now();
const eng = real
  ? await Engine.load(DATA, { fetchJson: async (p) => JSON.parse(await readFile(p, 'utf8')), workers: 0 })
  : await Engine.load('mem/', { fetchJson: memoryFetch(makeDataFiles()), workers: 0 });
console.log(`data: ${real ? 'web/data' : 'synthetic'}, ${eng.lib.n} plays, load ${ms(t)}`);

const lib = eng.lib;
const drill = eng.spotIndex.spots.find((s) => s.cat === 'drill');
const spot = await eng.loadSpot(drill.id);
const ctx = buildContext(spot);
const s0 = initialState(spot);
const opts = [];
for (let c = 0; opts.length < 40; c = (c + 1) % lib.nCalls) {
  if (lib.isTrick[c] || c === lib.hail) continue;
  opts.push({ kind: 'offense', a: { type: 'play', call: c, tempo: opts.length < 20 ? 'hurry' : 'normal', timeout: false, oob: opts.length >= 30 }, look: 0 });
}
evaluate(lib, ctx, s0, opts.slice(0, 4), { n: 50, seed: 1 });
for (const [n, label] of [[400, 'round 1'], [2400, 'round 2 (4 options)']]) {
  const set = n === 400 ? opts : opts.slice(0, 4);
  t = performance.now();
  evaluate(lib, ctx, s0, set, { n, seed: 2 });
  const el = performance.now() - t;
  console.log(`${label}: ${set.length} options x ${n} runs (${spot.id}, ${s0.clock}s left): ${el.toFixed(0)} ms, ${((el * 1000) / (set.length * n)).toFixed(1)} us per game`);
}

const game = eng.newGame(spot, { seed: 7 });
t = performance.now();
await game.prefetch();
console.log(`prefetch of the first decision (in-thread): ${ms(t)}`);
t = performance.now();
const r = await game.act({ type: 'play', call: 'short_r', tempo: 'hurry' });
console.log(`act, graded over ${r.grade.options.length} options (in-thread, after prefetch): ${ms(t)}`);
t = performance.now();
const g2 = eng.newGame(spot, { seed: 8 });
await g2.act({ type: 'play', call: 'deep_m', oob: true });
console.log(`act without prefetch (in-thread): ${ms(t)}`);
