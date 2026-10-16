import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draws } from '../../web/js/engine/rng.js';
import { initialState } from '../../web/js/engine/rules.js';
import { buildContext } from '../../web/js/engine/resolve.js';
import {
  canKneelOut, defenseTimeout, fourthDown, kickoffAction, kneelOffered, offenseAction, patAction,
  sampleCall, usualTempo,
} from '../../web/js/engine/policy.js';
import { makeSpot, synthEngine } from '../fixtures/synth.js';

const { eng } = await synthEngine();
const lib = eng.lib;
const spot = makeSpot();
const ctx = buildContext(spot);
// KC (1) has the ball; NO is home (0).
const st = (over) => ({ ...initialState(spot), ...over });
const act = (s, r = 0) => offenseAction(lib, ctx, s, new Draws(3, r));

test('kneel-out: only when the defense cannot stop it', () => {
  const lead = { score: [20, 24], qtr: 4, warned: true };
  assert.equal(canKneelOut(st({ ...lead, clock: 40, down: 1, running: true, to: [0, 3] })), true);
  assert.equal(canKneelOut(st({ ...lead, clock: 90, down: 1, running: true, to: [3, 3] })), false);
  assert.equal(canKneelOut(st({ ...lead, clock: 100, down: 1, running: true, to: [0, 3] })), true);
  assert.equal(canKneelOut(st({ ...lead, clock: 125, down: 1, running: true, to: [0, 3], warned: false })), false, 'the two-minute warning stops one gap');
  assert.equal(act(st({ ...lead, clock: 40, running: true, to: [1, 3] })).type, 'kneel');
  assert.equal(act(st({ ...lead, clock: 200, running: true, to: [3, 3] })).type, 'play');
  assert.equal(kneelOffered(st({ ...lead, clock: 60, down: 2, to: [1, 3] })), true);
  assert.equal(kneelOffered(st({ clock: 60 })), false, 'not when trailing in the second half');
  assert.equal(kneelOffered(st({ ...lead, clock: 60, down: 4 })), false);
});

test('fourth down late and behind: go for it', () => {
  const s = st({ score: [27, 20], clock: 90, down: 4, ytg: 8, yl: 60 });
  for (let r = 0; r < 20; r++) assert.equal(act(s, r).type, 'play');
  assert.equal(fourthDown(lib, ctx, s, 0.99), 'go');
});

test('a walk-off or tying field goal is kicked', () => {
  const tie = st({ score: [20, 20], clock: 3, down: 2, ytg: 7, yl: 18 });
  const a = act(tie);
  assert.equal(a.type, 'fg');
  const behind = st({ score: [22, 20], clock: 30, down: 4, ytg: 6, yl: 20 });
  assert.equal(act(behind).type, 'fg');
  const deep = st({ score: [27, 20], clock: 3, down: 2, ytg: 7, yl: 18 });
  assert.notEqual(act(deep).type, 'fg', 'a field goal does not help when down 7');
});

test('kick to win: run the clock down, timeout at 0:03, kick', () => {
  const s = st({ score: [21, 20], clock: 40, down: 2, ytg: 5, yl: 15, running: true, to: [2, 1] });
  const a = act(s);
  assert.equal(a.type, 'fg');
  assert.equal(a.rundown, true);
  const early = st({ score: [21, 20], clock: 150, down: 1, ytg: 10, yl: 15, running: true, to: [2, 1], warned: true });
  const b = act(early);
  assert.equal(b.type, 'play');
  assert.equal(b.tempo, 'milk');
  assert.equal(lib.isPass[b.call], 0, 'safe runs while milking the clock');
  assert.equal(b.keep, 12);
});

test('spikes, timeouts and the Hail Mary', () => {
  const spike = st({ score: [27, 20], clock: 30, down: 1, running: true, to: [3, 0], yl: 45 });
  assert.equal(act(spike).type, 'spike');
  const to = st({ score: [27, 20], clock: 50, down: 1, running: true, to: [3, 2], yl: 45 });
  const a = act(to);
  assert.equal(a.type, 'play');
  assert.equal(a.timeout, true);
  const hail = st({ score: [27, 21], clock: 5, down: 1, yl: 55 });
  assert.equal(act(hail).call, lib.hail);
  const notHail = st({ score: [27, 21], clock: 50, down: 1, yl: 55 });
  for (let r = 0; r < 30; r++) assert.notEqual(act(notHail, r).call, lib.hail);
  const oob = act(st({ score: [27, 20], clock: 80, down: 1, running: false, to: [3, 0], yl: 60 }));
  assert.equal(oob.oob, true, 'no timeouts left: get out of bounds');
});

test('tempo by situation', () => {
  assert.equal(usualTempo(lib, ctx, st({ score: [27, 20], clock: 200 })), 'hurry');
  assert.equal(usualTempo(lib, ctx, st({ score: [20, 27], clock: 400 })), 'milk');
  assert.equal(usualTempo(lib, ctx, st({ score: [20, 20], qtr: 3, clock: 600 })), 'normal');
  assert.equal(usualTempo(lib, ctx, st({ score: [20, 20], qtr: 2, clock: 100, yl: 60 })), 'hurry');
  assert.equal(usualTempo(lib, ctx, st({ score: [20, 20], qtr: 2, clock: 30, yl: 95, to: [3, 0] })), 'milk');
});

test('defensive timeouts: trailing late, never when the offense can kneel it out', () => {
  // NO has the ball and leads; KC (the defense) trails.
  const s = st({ pos: 0, score: [24, 20], clock: 150, running: true, down: 2, ytg: 6, yl: 60, to: [3, 2] });
  assert.equal(defenseTimeout(lib, ctx, s), true);
  assert.equal(defenseTimeout(lib, ctx, { ...s, running: false }), false);
  assert.equal(defenseTimeout(lib, ctx, { ...s, to: [3, 0] }), false);
  assert.equal(defenseTimeout(lib, ctx, { ...s, score: [20, 24] }), false, 'the leading defense lets it run');
  assert.equal(defenseTimeout(lib, ctx, { ...s, clock: 30, down: 1, to: [3, 2] }), false, 'the offense can kneel it out');
  assert.equal(defenseTimeout(lib, ctx, { ...s, qtr: 3, clock: 150 }), false);
});

test('tries and kickoffs', () => {
  const pat = st({ phase: 'pat', score: [27, 25], clock: 100, yl: 15 });
  for (let r = 0; r < 20; r++) assert.equal(patAction(lib, ctx, pat, new Draws(1, r)).kind, 'two', 'down 2 late: go for two');
  const early = st({ phase: 'pat', score: [7, 6], qtr: 1, clock: 600, yl: 15 });
  let xp = 0;
  for (let r = 0; r < 100; r++) if (patAction(lib, ctx, early, new Draws(1, r)).kind === 'xp') xp++;
  assert.ok(xp > 90);
  const ko = st({ phase: 'kickoff', kicker: 1, pos: 1, score: [27, 20], clock: 60 });
  assert.equal(kickoffAction(lib, ctx, ko).onside, true);
  assert.equal(kickoffAction(lib, ctx, { ...ko, score: [20, 27] }).onside, false);
  assert.equal(kickoffAction(lib, ctx, { ...ko, qtr: 3 }).onside, false);
  assert.equal(kickoffAction(lib, ctx, { ...ko, free: true }).onside, false);
});

test('call sampling follows the NFL mix and can be restricted', () => {
  const key = 100;
  for (let j = 0; j < 200; j++) {
    const u = (j + 0.5) / 200;
    assert.notEqual(sampleCall(lib, key, u), lib.hail);
    assert.equal(lib.isPass[sampleCall(lib, key, u, 1)], 0);
    assert.equal(lib.isPass[sampleCall(lib, key, u, 2)], 1);
  }
  let deep = 0;
  let deepVsLoad = 0;
  for (let j = 0; j < 2000; j++) {
    const u = (j + 0.5) / 2000;
    if (lib.isDeep[sampleCall(lib, key, u, 0, 0)]) deep++;
    if (lib.isDeep[sampleCall(lib, key, u, 0, 2)]) deepVsLoad++;
  }
  assert.ok(deepVsLoad > deep, 'the offense checks into deep shots against a loaded box');
});
