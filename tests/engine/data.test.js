import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FL, MIN_LOOK_POOL, MIN_POOL, MODE, distOf, downOf, gameMode, keyParts, sitKey, zoneOf,
} from '../../web/js/engine/data.js';
import { synthEngine } from '../fixtures/synth.js';

const { eng } = await synthEngine();
const lib = eng.lib;

test('situation buckets follow DATA.md edges', () => {
  assert.deepEqual([1, 3, 4, 10, 11, 20, 21, 40, 41, 60, 61, 80, 81, 99].map(zoneOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  assert.deepEqual([1, 2, 3, 5, 6, 10, 11, 25].map(distOf), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([1, 2, 3, 4].map(downOf), [0, 1, 2, 2]);
  for (let key = 0; key < 252; key++) {
    const p = keyParts(key);
    assert.equal(((p.mode * 3 + p.down) * 4 + p.dist) * 7 + p.zone, key);
  }
  assert.equal(sitKey(MODE.HURRY, 3, 4, 35), ((1 * 3 + 2) * 4 + 1) * 7 + 3);
});

test('game mode matches the pipeline definition', () => {
  assert.equal(gameMode(false, 121, -3), MODE.NORMAL);
  assert.equal(gameMode(false, 120, 10), MODE.HURRY);
  assert.equal(gameMode(true, 300, -1), MODE.HURRY);
  assert.equal(gameMode(true, 301, -1), MODE.NORMAL);
  assert.equal(gameMode(true, 120, 0), MODE.HURRY);
  assert.equal(gameMode(true, 121, 0), MODE.NORMAL);
  assert.equal(gameMode(true, 600, -9), MODE.HURRY);
  assert.equal(gameMode(true, 360, 1), MODE.KILL);
  assert.equal(gameMode(true, 361, 1), MODE.NORMAL);
});

test('pools hold at least MIN_POOL plays of their call and widen when sparse', () => {
  const call = lib.callId('short_r');
  const key = sitKey(MODE.HURRY, 1, 10, 75);
  const pool = lib.pool(call, key);
  assert.ok(pool.n >= MIN_POOL);
  for (const i of pool.idx) assert.equal(lib.call[i], call);
  assert.ok(pool.sd > 0);
  const rare = lib.pool(lib.callId('flea_flicker'), sitKey(MODE.KILL, 3, 1, 2));
  assert.ok(rare.n >= 1);
  assert.ok(rare.level > 0, 'a sparse situation is widened');
  assert.equal(lib.pool(call, key), pool, 'pools are cached');
});

test('look pools only hold plays against that look', () => {
  const call = lib.callId('run_middle');
  const key = sitKey(MODE.NORMAL, 1, 10, 50);
  for (let look = 0; look < 4; look++) {
    const pool = lib.lookPool(call, key, look);
    if (!pool) continue;
    assert.ok(pool.n >= MIN_LOOK_POOL);
    for (const i of pool.idx) assert.equal(lib.look[i], look);
  }
});

test('tilted draws move the outcome distribution', () => {
  const pool = lib.pool(lib.callId('short_m'), sitKey(MODE.NORMAL, 1, 10, 60));
  const mean = (k, oob) => {
    let s = 0;
    let o = 0;
    const n = 4000;
    for (let j = 0; j < n; j++) {
      const i = lib.draw(pool, k, oob, (j + 0.5) / n);
      s += lib.epa[i];
      if (lib.fl[i] & FL.OOB) o++;
    }
    return { epa: s / n, oob: o / n };
  };
  const flat = mean(0, false);
  assert.ok(mean(0.4, false).epa > flat.epa + 0.1);
  assert.ok(mean(-0.4, false).epa < flat.epa - 0.1);
  assert.ok(mean(0, true).oob > flat.oob * 1.8, 'get out of bounds favours OOB plays');
  assert.ok(Math.abs(flat.epa - pool.mean) < 0.05, 'untilted draws are uniform');
});

test('call and look mixes are distributions', () => {
  const key = sitKey(MODE.HURRY, 2, 7, 45);
  const mix = lib.mix(key);
  const total = mix.freq.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(mix.total - (1 - mix.freq[lib.hail])) < 1e-9, 'the policy mix leaves out the Hail Mary');
  const looks = lib.lookMix(key);
  assert.equal(looks.length, 4);
  assert.ok(Math.abs(looks.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const two = lib.twoMix();
  assert.equal(two.freq[lib.hail], 0);
  assert.ok(Math.abs(two.total - 1) < 1e-9);
});

test('runoff draws stay within the play clock and grow with tempo', () => {
  let prev = 0;
  for (let j = 0; j < 50; j++) {
    const v = lib.runoff('normal', j / 50);
    assert.ok(v >= 1 && v <= 40);
    assert.ok(v >= prev);
    prev = v;
  }
  assert.ok(lib.runoff('hurry', 0.5) < lib.runoff('normal', 0.5));
  assert.ok(lib.runoff('normal', 0.5) < lib.runoff('kill', 0.5));
});

test('field-goal model falls with distance and is zero past 76 yards', () => {
  const weather = { indoor: true, wind: 0 };
  const ps = [5, 20, 35, 45, 55].map((yl) => lib.fgProb(yl, weather));
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i] < ps[i - 1]);
  assert.ok(ps[0] > 0.9);
  assert.equal(lib.fgProb(60, weather), 0);
  assert.ok(lib.fgProb(30, weather, -0.3) < lib.fgProb(30, weather));
});

test('sacks and scrambles of the catch-all calls become a shared family pressure pool', () => {
  const shortM = lib.callId('short_m');
  const f = lib.family[shortM];
  assert.equal(f, lib.family[lib.callId('deep_l')]);
  assert.notEqual(lib.family[lib.callId('pa_deep')], f);
  assert.equal(lib.family[lib.callId('run_middle')], -1);
  const key = sitKey(MODE.HURRY, 1, 10, 70);
  for (const i of lib.pool(shortM, key).idx) assert.equal(lib.fl[i] & (FL.SACK | FL.SCRAMBLE), 0);
  const pressure = lib.pressurePool(f, key);
  assert.ok(pressure.n > 0);
  for (const i of pressure.idx) {
    assert.equal(lib.call[i], shortM);
    assert.ok(lib.fl[i] & (FL.SACK | FL.SCRAMBLE));
  }
  const rate = lib.pressureRate(f, key);
  assert.ok(rate > 0.01 && rate < 0.3, `rate ${rate}`);
  assert.equal(lib.drawPool(lib.callId('deep_r'), key, -1, rate / 2), pressure);
  assert.equal(lib.drawPool(lib.callId('deep_r'), key, -1, (1 + rate) / 2), lib.pool(lib.callId('deep_r'), key));
  assert.equal(lib.drawPool(lib.callId('run_middle'), key, -1, 0), lib.pool(lib.callId('run_middle'), key));
  let counted = 0;
  for (const v of lib.keyCounts) counted += v;
  let plays = 0;
  for (let i = 0; i < lib.n; i++) if (!lib.two[i]) plays++;
  assert.ok(Math.abs(counted - plays) < 1e-6, 'the call mix still counts every snap');
  assert.ok(lib.twoPressureRate(f) > 0 && lib.twoPressureRate(f) < 0.5);
});

test('kick tables and models are indexed', () => {
  const punts = lib.puntPool(70);
  assert.ok(punts.all.length >= 30);
  for (const j of punts.clean) assert.equal(lib.punt.fl[j] & 1, 0);
  assert.ok(lib.punt.blockRate > 0 && lib.punt.blockRate < 0.05);
  assert.ok(lib.kickoff.recv.length > 0);
  assert.ok(lib.twoPool(lib.callId('short_m')).n >= MIN_POOL);
  assert.equal(lib.fourthProbs({}), null, 'no special.fourth model in the fixture');
  assert.ok(lib.go2Rate(-2, true) > lib.go2Rate(-3, true));
  const wp = lib.halftimeWp(7, 1, 3);
  assert.ok(wp > 0.5 && wp < 1);
  assert.ok(Math.abs(lib.halftimeWp(0, 0, 0) - 0.5) < 1e-9);
  const prov = lib.provenance(0);
  assert.ok(prov.gameId && Number.isInteger(prov.pid) && prov.season >= 2022);
});
