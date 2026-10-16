import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../web/js/engine/index.js';
import { synthEngine } from '../fixtures/synth.js';

const { eng } = await synthEngine();
const FAST = { r1: 40, r2: 80, after: 40 };
const spotOf = (id) => eng.loadSpot(id);
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** A legal action for a decision, chosen with a simple deterministic rotation. */
function pickAction(d, k) {
  if (d.kind === 'auto') return { type: 'auto' };
  const o = d.options[(k * 7 + 3) % d.options.length];
  const timeout = !!d.timeout?.available && k % 5 === 0;
  if (d.kind === 'offense') {
    const tempo = d.tempo ? d.tempo.choices[k % 3] : undefined;
    if (o.type === 'play') return { type: 'play', call: o.call, tempo, timeout, oob: !!d.oob.available && k % 2 === 0 };
    return { ...o, tempo, timeout };
  }
  return { ...o, timeout };
}

async function playOut(game, maxActs = 300) {
  const results = [];
  for (let k = 0; !game.over && k < maxActs; k++) {
    const d = game.decision();
    if (k % 3 === 0) game.prefetch(d);
    results.push(await game.act(pickAction(d, k)));
  }
  return results;
}

test('engine: schedule, spots and survivor list', async () => {
  assert.equal(eng.dailySpotId('2026-10-16'), 'drill1');
  assert.equal(eng.dailySpotId('2026-10-18'), 'tight1');
  assert.equal(eng.dailySpotId('2026-10-19'), 'drill1');
  assert.deepEqual(eng.survivorSpotIds(), ['q41']);
  assert.equal(eng.spotIndex.launch, '2026-10-16');
  const spot = await spotOf('drill1');
  assert.equal(spot.id, 'drill1');
  assert.equal(await spotOf('drill1'), spot, 'cached');
  await assert.rejects(eng.loadSpot('nope'));
  assert.equal(eng.pool.size, 0, 'Node: in-thread evaluation');
});

test('offense decision: options, NFL numbers, look and clock settings', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 1, runs: FAST });
  const d = game.decision();
  assert.equal(d.kind, 'offense');
  assert.equal(d.team, 1);
  assert.equal(d.situation.clockText, 'Q4 1:58');
  assert.equal(d.situation.downText, '1st & 10');
  assert.equal(d.situation.ballText, 'KC 25');
  assert.equal(d.situation.userView, 'own 25');
  assert.deepEqual(d.situation.score, { user: 20, opp: 23 });
  assert.ok(['base', 'blitz', 'load', 'soft'].includes(d.look));
  assert.equal(d.tempo, null, 'the clock is stopped: no tempo choice');
  assert.equal(d.timeout.available, false);
  assert.equal(d.oob.available, true);
  const short = d.options.find((o) => o.id === 'short_r');
  for (const k of ['freq', 'avg', 'conv', 'inc', 'oob', 'td', 'tov']) assert.ok(finite(short.nfl[k]), k);
  assert.ok(short.nfl.n >= 40);
  assert.ok(!d.options.some((o) => o.id === 'hail_mary'), 'no Hail Mary with 1:58 left');
  assert.ok(!d.options.some((o) => o.id === 'qb_sneak'), 'no sneak on 1st and 10');
  assert.ok(!d.options.some((o) => o.type === 'punt'));
  assert.equal(game.decision(), d, 'decisions are cached until act()');
});

test('acting: grade, log, win chances, history', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 1, runs: FAST });
  const d = game.decision();
  await game.prefetch(d);
  const r = await game.act({ type: 'play', call: 'short_r', oob: true });
  assert.ok(finite(r.wpBefore) && finite(r.wpAfter));
  assert.ok(r.wpBefore >= 0 && r.wpBefore <= 1 && r.wpAfter >= 0 && r.wpAfter <= 1);
  const g = r.grade;
  assert.equal(g.chosenKey, 'play:short_r:-+oob');
  assert.ok(g.best >= g.chosen);
  assert.ok(Math.abs(g.delta - (g.best - g.chosen) * 100) < 1e-9);
  assert.ok(['✓', '≈', '!', '✗'].includes(g.symbol));
  assert.ok(g.options.length >= 20);
  for (let i = 1; i < g.options.length; i++) assert.ok(g.options[i - 1].wp >= g.options[i].wp);
  assert.equal(g.options.filter((o) => o.chosen).length, 1);
  assert.equal(g.options[0].best, true);
  assert.ok(Math.abs(g.options.reduce((s, o) => s + o.freq, 0) - 1) < 1e-9);
  assert.ok(g.options.some((o) => o.key.startsWith('fg') === false && o.n === FAST.r2), 'leaders refined');
  assert.ok(r.log.length >= 1);
  const e = r.log[0];
  assert.equal(e.type, 'play');
  assert.equal(e.call, 'short_r');
  assert.ok(e.text.length > 10);
  assert.ok(e.real.gameId);
  assert.ok(e.anim);
  assert.equal(e.clockBefore, 118);
  assert.deepEqual(r.state, game.state);
  assert.equal(game.history.length, 1);
  assert.equal(game.history[0].choice.key, g.chosenKey);
  assert.ok(game.history[0].log.every((x) => !('state' in x)), 'history entries do not keep states');
  assert.equal(game.decision().seq, 1);
  assert.deepEqual(game.tend, ['short_r']);
});

test('clock settings: a running clock offers tempos and timeouts and grades their variants', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 2, runs: FAST });
  game.state = { ...game.state, running: true, clock: 90, down: 2, ytg: 6, yl: 60 };
  const d = game.decision();
  assert.deepEqual(d.tempo.choices, ['hurry', 'normal', 'milk']);
  assert.equal(d.defaults.tempo, 'hurry');
  assert.equal(d.timeout.available, true);
  assert.ok(d.options.some((o) => o.id === 'spike'));
  const r = await game.act({ type: 'play', call: 'deep_l', tempo: 'milk', timeout: false });
  const keys = r.grade.options.map((o) => o.key);
  assert.ok(keys.includes('play:deep_l:milk'));
  assert.ok(keys.includes('play:short_r:hurry'), 'every call under the default settings');
  assert.ok(keys.includes('play:short_r:milk'), 'every call under the chosen settings');
  assert.ok(keys.some((k) => k.endsWith(':to')), 'timeout variants for the leading calls');
  assert.ok(!keys.some((k) => k.startsWith('play:flea_flicker')), 'trick plays only when chosen');
});

test('determinism: same seed and choices give the same game; toJSON round-trips', async () => {
  const spot = await spotOf('protect1');
  const a = eng.newGame(spot, { seed: 99, runs: FAST });
  const b = eng.newGame(spot, { seed: 99, runs: FAST });
  for (let k = 0; k < 4 && !a.over; k++) {
    const ra = await a.act(pickAction(a.decision(), k));
    const rb = await b.act(pickAction(b.decision(), k));
    assert.deepEqual(ra.state, rb.state);
    assert.deepEqual(ra.log.map((e) => e.text), rb.log.map((e) => e.text));
    assert.equal(ra.wpAfter, rb.wpAfter);
  }
  const json = JSON.parse(JSON.stringify(a.toJSON()));
  const c = await Engine.restore(eng, json);
  assert.deepEqual(c.state, a.state);
  assert.equal(c.seq, a.seq);
  assert.deepEqual(c.decision().options.map((o) => o.id), a.decision().options.map((o) => o.id));
  assert.equal(c.decision().look, a.decision().look);
  if (!a.over) {
    const k = 4;
    const ra = await a.act(pickAction(a.decision(), k));
    const rc = await c.act(pickAction(c.decision(), k));
    assert.deepEqual(rc.state, ra.state);
  }
  assert.throws(() => c.constructor.fromJSON(eng, { ...json, spotId: 'other' }, spot));
});

test('try decision: extra point or two by call', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 3, runs: FAST });
  game.state = { ...game.state, phase: 'pat', yl: 15, ytg: 15, score: [23, 26], clock: 40 };
  const d = game.decision();
  assert.equal(d.kind, 'pat');
  assert.equal(d.options[0].id, 'xp');
  assert.ok(d.options[0].p > 0.9);
  const two = d.options.find((o) => o.id === 'two:short_m');
  assert.ok(two.nfl.conv > 0 && two.nfl.conv < 1);
  const r = await game.act({ type: 'pat', kind: 'two', call: 'short_m' });
  assert.ok(r.grade.options.some((o) => o.key === 'pat:xp'));
  assert.ok(['two', 'xp'].includes(r.log[0].type));
  assert.equal(game.history[0].measures.two.n, 1);
  assert.equal(game.history[0].measures.two.mine, 1);
});

test('kickoff decision with an onside option when trailing late', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 4, runs: FAST });
  game.state = { ...game.state, phase: 'kickoff', kicker: 1, pos: 1, clock: 90, score: [27, 20] };
  const d = game.decision();
  assert.equal(d.kind, 'kickoff');
  assert.deepEqual(d.options.map((o) => o.id), ['deep', 'onside']);
  const r = await game.act({ type: 'kickoff', onside: true });
  assert.equal(r.grade.options.length, 2);
  assert.equal(r.log[0].type, 'kickoff');
  const lead = eng.newGame(await spotOf('drill1'), { seed: 4, runs: FAST });
  lead.state = { ...lead.state, phase: 'kickoff', kicker: 1, pos: 1, clock: 90, score: [20, 27] };
  assert.equal(lead.decision().kind, 'auto', 'no onside when leading: the kickoff is automatic');
});

test('defense and kick-defense decisions', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 5, runs: FAST });
  game.state = { ...game.state, pos: 0, down: 2, ytg: 7, yl: 65, clock: 150, running: true, score: [23, 20] };
  const d = game.decision();
  assert.equal(d.kind, 'defense');
  assert.deepEqual(d.options.map((o) => o.look), ['base', 'blitz', 'load', 'soft']);
  assert.equal(d.timeout.available, true);
  const r = await game.act({ type: 'defense', look: 'blitz', timeout: true });
  assert.ok(r.grade.options.some((o) => o.key === 'def:base'));
  assert.ok(r.grade.options.some((o) => o.key === 'def:soft:to'));
  assert.equal(r.log[0].type, 'timeout');
  assert.equal(r.log[0].team, 1);

  const punt = eng.newGame(await spotOf('drill1'), { seed: 6, runs: FAST });
  punt.state = { ...punt.state, qtr: 3, clock: 600, pos: 0, down: 4, ytg: 15, yl: 80, score: [20, 20], warned: false };
  const k = punt.decision();
  assert.equal(k.kind, 'kick_defense');
  assert.equal(k.kick, 'punt');
  assert.deepEqual(k.options.map((o) => o.id), ['safe', 'block']);
  const rk = await punt.act({ type: 'kick_defense', block: true });
  assert.equal(rk.log[0].type, 'punt');
  assert.equal(rk.grade.options.length, 2);
});

test('opponent tries and kickoffs are automatic; opponent timeouts follow the user\'s snap', async () => {
  const game = eng.newGame(await spotOf('drill1'), { seed: 7, runs: FAST });
  game.state = { ...game.state, phase: 'pat', pos: 0, yl: 15, score: [29, 20], clock: 100 };
  const d = game.decision();
  assert.equal(d.kind, 'auto');
  assert.equal(d.auto.event, 'pat');
  const r = await game.act({ type: 'auto' });
  assert.equal(r.grade, null);
  assert.ok(finite(r.wpBefore));
  assert.equal(game.decision().kind, 'auto', 'then their kickoff');
  await assert.rejects(game.act({ type: 'play', call: 'short_r' }), /expected/);
  const first = game.act({ type: 'auto' });
  await assert.rejects(game.act({ type: 'auto' }), /still being resolved/);
  await first;

  let checked = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const lead = eng.newGame(await spotOf('protect1'), { seed, runs: FAST });
    lead.state = { ...lead.state, clock: 150, warned: true, down: 1, yl: 60 };
    const res = await lead.act({ type: 'play', call: 'run_middle' });
    if (res.state.phase !== 'snap' || res.state.pos !== lead.user || res.log[0].anim?.oob || res.log[0].anim?.penalty) continue;
    assert.equal(res.log.at(-1).type, 'timeout', 'the trailing opponent stops the clock');
    assert.equal(res.log.at(-1).team, 1);
    assert.equal(res.state.running, false);
    checked++;
  }
  assert.ok(checked > 0);
});

test('whole games on every synthetic spot end cleanly with a summary', async () => {
  for (const id of ['drill1', 'protect1', 'tight1', 'q41']) {
    const game = eng.newGame(await spotOf(id), { seed: 11, runs: FAST, mode: id === 'q41' ? 'survivor' : 'daily' });
    const results = await playOut(game);
    assert.ok(game.over, `${id} finished`);
    for (const r of results) {
      assert.ok(finite(r.wpBefore) && finite(r.wpAfter), id);
      if (r.grade) assert.ok(finite(r.grade.delta) && r.grade.options.every((o) => finite(o.wp) && finite(o.freq)));
      for (const e of r.log) assert.ok(typeof e.text === 'string' && !e.text.includes('undefined') && !e.text.includes('NaN'), e.text);
    }
    const s = game.summary();
    assert.equal(s.over, true);
    assert.ok(['win', 'loss', 'tie', 'half'].includes(s.result));
    if (id === 'tight1') assert.equal(s.result, 'half');
    if (id === 'q41') assert.equal(s.alive, s.result !== 'loss');
    assert.ok(s.percentile === null || (s.percentile >= 0 && s.percentile <= 100));
    assert.ok(finite(s.cost) && finite(s.typical.cost) && finite(s.typical.wpa));
    assert.equal(s.squares.length, s.decisions.length);
    assert.ok(['better', 'worse', 'same'].includes(s.real.verdict));
    assert.equal(s.real.coach, game.spot.team === game.spot.away ? 'Away Coach' : 'Home Coach');
    assert.ok(finite(s.winChance));
    for (const m of ['pass', 'deep', 'go', 'two']) assert.ok(s.measures[m].n >= 0);
  }
});

test('engine look-alike helpers for totals kept across days', () => {
  const t = eng.addMeasures(eng.emptyMeasures(), { pass: { n: 8, mine: 8, exp: 5 } });
  assert.equal(eng.lookalike(t).coach.name, 'Air Raid');
});
