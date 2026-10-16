import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FL, MODE, sitKey } from '../../web/js/engine/data.js';
import { Draws } from '../../web/js/engine/rng.js';
import { initialState } from '../../web/js/engine/rules.js';
import {
  buildContext, describe, matchupTable, playOutcome, resolveKickoff, resolvePat, resolveSnap,
} from '../../web/js/engine/resolve.js';
import { makeSpot, synthEngine } from '../fixtures/synth.js';

const { eng } = await synthEngine();
const lib = eng.lib;
const spot = makeSpot();
const ctx = buildContext(spot);
const s0 = initialState(spot);
const call = (id) => lib.callId(id);

/** Find a play in the library matching a predicate. */
function findPlay(pred) {
  for (let i = 0; i < lib.n; i++) if (pred(i)) return i;
  throw new Error('no such play in the fixture');
}

test('team context: strength tilts are capped and kickers shift the FG logit', () => {
  for (const t of [0, 1]) for (const k of [0, 1]) assert.ok(Math.abs(ctx.delta[t][k]) <= 0.15);
  assert.ok(ctx.delta[1][1] > ctx.delta[1][0], 'KC passes better than it runs in the fixture');
  assert.equal(ctx.user, 1);
  assert.equal(ctx.weather.indoor, true);
  const t = matchupTable(lib);
  assert.equal(t[call('screen') * 4 + 1], 1, 'screens beat the blitz');
  assert.equal(t[call('run_middle') * 4 + 2], -1, 'runs lose to a loaded box');
  assert.equal(t[call('pa_deep') * 4 + 2], 1, 'play action beats a loaded box');
  assert.equal(t[call('run_middle') * 4 + 0], 0, 'base look: no matchup');
});

test('play outcome: the 60% rule for touchdowns drawn from farther out', () => {
  const i = findPlay((j) => (lib.fl[j] & FL.TD) && lib.yds[j] >= 10 && lib.yds[j] <= 20 && !(lib.fl[j] & FL.PEN));
  const yds = lib.yds[i];
  assert.equal(playOutcome(lib, i, { yl: yds }).td, true);
  assert.equal(playOutcome(lib, i, { yl: Math.floor(yds / 0.6) }).td, true);
  const far = playOutcome(lib, i, { yl: Math.ceil(yds / 0.6) + 2 });
  assert.equal(far.td, false);
  assert.equal(far.gain, yds, 'tackled after its real yardage');
  const long = findPlay((j) => !(lib.fl[j] & (FL.TD | FL.PEN | FL.INT | FL.FUM)) && lib.yds[j] >= 20);
  assert.equal(playOutcome(lib, long, { yl: 10 }).td, true, 'a long gain near the goal line scores');
});

test('play outcome: turnovers, safeties and penalty caps', () => {
  const int = findPlay((j) => (lib.fl[j] & FL.INT) && !(lib.fl[j] & FL.DEFTD));
  const o = playOutcome(lib, int, { yl: 75 });
  assert.equal(o.tov, true);
  assert.equal(o.defYl, 100 - 75 + lib.tov[int]);
  const sack = findPlay((j) => (lib.fl[j] & FL.SACK) && lib.yds[j] <= -5);
  assert.equal(playOutcome(lib, sack, { yl: 97 }).safety, true);
  assert.equal(playOutcome(lib, sack, { yl: 60 }).safety, false);
  const pen = findPlay((j) => (lib.fl[j] & FL.NOPLAY) && lib.yds[j] === 15);
  assert.equal(playOutcome(lib, pen, { yl: 8 }).gain, 7, 'big fouls stop at the 1');
  const pen5 = findPlay((j) => (lib.fl[j] & FL.NOPLAY) && lib.yds[j] === 5);
  assert.equal(playOutcome(lib, pen5, { yl: 6 }).gain, 3, 'half the distance to the goal');
  const back = findPlay((j) => (lib.fl[j] & FL.NOPLAY) && lib.yds[j] === -10);
  assert.equal(playOutcome(lib, back, { yl: 95 }).gain, -2, 'half the distance to the own goal');
  const fum = findPlay((j) => (lib.fl[j] & FL.FUM) && !(lib.fl[j] & FL.INT) && lib.yds[j] >= 3);
  const fo = playOutcome(lib, fum, { yl: 2 });
  assert.equal(fo.td, true, 'a fumble that now happens past the goal line is a touchdown');
  assert.equal(fo.tov, false);
});

test('resolution is deterministic for fixed draws', () => {
  const a = { type: 'play', call: call('short_r'), tempo: 'hurry', timeout: false, oob: false };
  for (let r = 0; r < 20; r++) {
    const x = resolveSnap(lib, ctx, s0, a, { look: 1 }, new Draws(5, r, 0));
    const y = resolveSnap(lib, ctx, s0, a, { look: 1 }, new Draws(5, r, 0));
    assert.deepEqual(x.state, y.state);
    assert.equal(x.ev.out.play, y.ev.out.play);
  }
  const plays = new Set();
  for (let r = 0; r < 20; r++) plays.add(resolveSnap(lib, ctx, s0, a, { look: 1 }, new Draws(5, r, 0)).ev.out.play);
  assert.ok(plays.size > 10, 'different runs draw different plays');
});

test('matchups tilt the draw within the look pool', () => {
  const key = sitKey(MODE.HURRY, 1, 10, 75);
  const shift = (id, look) => {
    const pool = lib.lookPool(call(id), key, look) || lib.pool(call(id), key);
    let s = 0;
    const n = 4000;
    for (let r = 0; r < n; r++) {
      const res = resolveSnap(lib, ctx, s0, { type: 'play', call: call(id), tempo: 'normal' }, { look }, new Draws(9, r, 0));
      s += lib.epa[res.ev.out.play];
    }
    return (s / n - pool.mean) / pool.sd;
  };
  assert.ok(shift('screen', 1) > 0.15, 'a screen against the blitz is tilted up');
  assert.ok(shift('deep_m', 1) < -0.1, 'a deep shot against the blitz is tilted down');
  assert.ok(Math.abs(shift('run_middle', 0) - ctx.delta[1][0] / lib.pool(call('run_middle'), key).sd) < 0.1, 'base look: team strength only');
});

test('kneel, spike and the clock before the snap', () => {
  const running = { ...s0, running: true, clock: 100, score: [20, 23] };
  const kneel = resolveSnap(lib, ctx, running, { type: 'kneel', tempo: 'milk' }, { look: -1 }, new Draws(1));
  assert.ok(kneel.ev.pre[0].secs >= 38 && kneel.ev.pre[0].secs <= 40);
  assert.equal(kneel.state.yl, s0.yl + 1);
  assert.equal(kneel.state.running, true);
  const spike = resolveSnap(lib, ctx, running, { type: 'spike' }, { look: -1 }, new Draws(1));
  assert.ok(spike.ev.pre[0].secs >= 5 && spike.ev.pre[0].secs <= 12);
  assert.equal(spike.state.running, false);
  assert.equal(spike.state.down, 2);
  const to = resolveSnap(lib, ctx, running, { type: 'play', call: call('run_middle'), tempo: 'milk', timeout: true }, { look: -1 }, new Draws(1));
  assert.equal(to.ev.pre[0].type, 'timeout');
  assert.equal(to.ev.pre.length, 1, 'no runoff after the timeout');
  assert.equal(to.state.to[1], 1);
});

test('a leading offense burns the last seconds', () => {
  const s = { ...s0, clock: 6, score: [20, 23], running: false };
  const r = resolveSnap(lib, ctx, s, { type: 'play', call: call('run_middle'), tempo: 'normal' }, { look: -1 }, new Draws(3));
  if (!r.ev.out.inc && !r.ev.out.td && !r.ev.out.tov) assert.equal(r.state.phase, 'done');
  const k = resolveSnap(lib, ctx, s, { type: 'kneel', tempo: 'normal' }, { look: -1 }, new Draws(3));
  assert.equal(k.state.phase, 'done');
  assert.equal(k.state.winner, 1);
});

test('field goals: fire drill, timeout, run it down', () => {
  const s = { ...s0, yl: 20, running: true, clock: 20, score: [23, 22] };
  const fire = resolveSnap(lib, ctx, s, { type: 'fg', timeout: false, tempo: 'normal' }, { look: -1 }, new Draws(2));
  assert.ok(fire.ev.fg.fire);
  assert.ok(fire.ev.pre[0].secs >= 7 && fire.ev.pre[0].secs <= 12);
  const set = resolveSnap(lib, ctx, s, { type: 'fg', timeout: true, tempo: 'normal' }, { look: -1 }, new Draws(2));
  assert.equal(set.ev.fg.fire, false);
  assert.equal(set.ev.clock0, 19);
  const rd = resolveSnap(lib, ctx, { ...s, clock: 40 }, { type: 'fg', rundown: true, timeout: true, tempo: 'milk' }, { look: -1 }, new Draws(2));
  assert.equal(rd.ev.clock0, 3, 'run down to 0:03, then the timeout');
  assert.equal(rd.ev.pre[1].why, 'kick');
  assert.equal(rd.state.to[1], 1);
  let made = 0;
  for (let r = 0; r < 400; r++) {
    if (resolveSnap(lib, ctx, { ...s, running: false }, { type: 'fg' }, { look: -1 }, new Draws(4, r)).ev.fg.made) made++;
  }
  assert.ok(Math.abs(made / 400 - lib.fgProb(20, ctx.weather, ctx.fgShift[1])) < 0.06);
});

test('kick blocks: a block attempt blocks more and draws roughing flags', () => {
  const s = { ...s0, yl: 30, down: 4 };
  let blocked = 0;
  let rough = 0;
  let safeBlocked = 0;
  const n = 6000;
  for (let r = 0; r < n; r++) {
    const b = resolveSnap(lib, ctx, s, { type: 'fg' }, { look: -1, block: true }, new Draws(6, r)).ev.fg;
    if (b.blocked) blocked++;
    if (b.roughing) rough++;
    if (resolveSnap(lib, ctx, s, { type: 'fg' }, { look: -1, block: false }, new Draws(6, r)).ev.fg.blocked) safeBlocked++;
  }
  assert.ok(blocked > 2.5 * safeBlocked);
  assert.ok(rough > 0);
  const punt = { ...s0, yl: 70, down: 4 };
  let pb = 0;
  for (let r = 0; r < n; r++) if (resolveSnap(lib, ctx, punt, { type: 'punt', tempo: 'normal' }, { look: -1, block: true }, new Draws(8, r)).ev.punt.blocked) pb++;
  assert.ok(pb / n > lib.punt.blockRate * 2);
  const one = resolveSnap(lib, ctx, punt, { type: 'punt', tempo: 'normal' }, { look: -1 }, new Draws(8, 1));
  assert.equal(one.state.pos === 0 || one.ev.punt.kickRec || one.ev.punt.roughing, true);
});

test('tries and kickoffs', () => {
  const pat = { ...s0, phase: 'pat', yl: 15, ytg: 15, score: [23, 26] };
  let good = 0;
  for (let r = 0; r < 500; r++) if (resolvePat(lib, ctx, pat, { kind: 'xp' }, new Draws(1, r)).ev.good) good++;
  assert.ok(good / 500 > 0.9);
  let two = 0;
  for (let r = 0; r < 500; r++) if (resolvePat(lib, ctx, pat, { kind: 'two', call: call('short_m') }, new Draws(1, r)).ev.good) two++;
  assert.ok(two / 500 > 0.2 && two / 500 < 0.8);
  const ko = { ...s0, phase: 'kickoff', kicker: 1, pos: 1 };
  let rec = 0;
  for (let r = 0; r < 2000; r++) if (resolveKickoff(lib, ctx, ko, { onside: true }, new Draws(2, r)).state.pos === 1) rec++;
  assert.ok(Math.abs(rec / 2000 - 0.08) < 0.03);
  const deep = resolveKickoff(lib, ctx, ko, { onside: false }, new Draws(2, 5)).state;
  assert.ok(deep.pos === 0 || deep.phase !== 'snap');
});

test('log entries name players, carry provenance and animation hints', () => {
  const a = { type: 'play', call: call('short_r'), tempo: 'normal', timeout: false, oob: false };
  let entry = null;
  for (let r = 0; r < 50 && !entry; r++) {
    const res = resolveSnap(lib, ctx, s0, a, { look: 0 }, new Draws(11, r));
    const e = describe(lib, spot, res.ev, s0, res.state);
    if (e.anim.complete) entry = e;
  }
  assert.ok(entry, 'a completion within 50 draws');
  assert.equal(entry.call, 'short_r');
  assert.match(entry.text, /^K\.Quarterback throws short to the right to K\./);
  assert.ok(entry.real.gameId && Number.isInteger(entry.real.pid));
  assert.equal(entry.players.passer.pos, 'QB');
  assert.ok(entry.players.target);
  assert.equal(entry.clockBefore, 118);
  assert.ok(entry.clockAfter < 118);
  assert.ok(['left', 'middle', 'right'].includes(entry.anim.loc));
  assert.equal(entry.anim.fromYl, 75);
  assert.equal(entry.state.pos, 1);
  const fg = resolveSnap(lib, ctx, { ...s0, yl: 20 }, { type: 'fg' }, { look: -1 }, new Draws(1));
  assert.match(describe(lib, spot, fg.ev, s0, fg.state).text, /K\.Kicker 38-yard field goal/);
});
