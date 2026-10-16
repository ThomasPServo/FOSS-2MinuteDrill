import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Draws, Rng, SLOT, addDays, cyrb53, dayIndex, dayNumber, hashInts, scheduleIndex, seedOf, utcDate,
} from '../../web/js/engine/rng.js';

test('Rng is deterministic per seed and in range', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const c = new Rng(43);
  const xs = Array.from({ length: 1000 }, () => a.float());
  const ys = Array.from({ length: 1000 }, () => b.float());
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs.slice(0, 10), Array.from({ length: 10 }, () => c.float()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
  for (let i = 0; i < 200; i++) {
    const k = a.int(7);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 7);
  }
});

test('Rng.reseed restarts a stream and derive gives an independent one', () => {
  const r = new Rng(1, 2, 3);
  const first = [r.u32(), r.u32()];
  r.reseed(1, 2, 3);
  assert.deepEqual([r.u32(), r.u32()], first);
  const d1 = new Rng(9).derive('x');
  const d2 = new Rng(9).derive('x');
  assert.equal(d1.u32(), d2.u32());
});

test('normal draws have mean 0 and sd 1', () => {
  const r = new Rng(5);
  const xs = Array.from({ length: 20000 }, () => r.normal());
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03);
  assert.ok(Math.abs(sd - 1) < 0.03);
});

test('Draws are addressed by (seed, run, event, slot)', () => {
  const d = new Draws(77);
  const v = d.set(3, 5).u(SLOT.PLAY);
  d.set(3, 5).u(SLOT.CALL);
  assert.equal(d.set(3, 5).u(SLOT.PLAY), v, 'drawing another slot does not shift this one');
  assert.notEqual(d.set(3, 6).u(SLOT.PLAY), v);
  assert.notEqual(d.set(4, 5).u(SLOT.PLAY), v);
  assert.notEqual(new Draws(78, 3, 5).u(SLOT.PLAY), v);
  let s = 0;
  for (let r = 0; r < 5000; r++) s += d.set(r, 0).u(SLOT.PLAY);
  assert.ok(Math.abs(s / 5000 - 0.5) < 0.02);
  const x = d.range(SLOT.RUNOFF, 7, 12);
  assert.ok(x >= 7 && x < 12);
});

test('string and integer hashes are stable and spread out', () => {
  assert.equal(cyrb53('2minute'), cyrb53('2minute'));
  assert.notEqual(cyrb53('a'), cyrb53('b'));
  assert.ok(Number.isSafeInteger(cyrb53('anything')));
  assert.equal(seedOf('daily', 'x'), seedOf('daily', 'x'));
  assert.ok(seedOf('daily', 'x') >= 0 && seedOf('daily', 'x') < 2 ** 32);
  assert.notEqual(hashInts(1, 2, 3), hashInts(1, 2, 4));
});

test('UTC date helpers drive the daily schedule', () => {
  assert.equal(dayNumber('1970-01-02'), 1);
  assert.equal(dayIndex('2026-10-16', '2026-10-16'), 0);
  assert.equal(dayIndex('2026-10-17', '2026-10-16'), 1);
  assert.equal(dayIndex('2027-10-16', '2026-10-16'), 365);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(scheduleIndex('2026-10-16', '2026-10-16', 3), 0);
  assert.equal(scheduleIndex('2026-10-19', '2026-10-16', 3), 0);
  assert.equal(scheduleIndex('2026-10-20', '2026-10-16', 3), 1);
  assert.equal(scheduleIndex('2026-10-15', '2026-10-16', 3), 2, 'days before launch wrap backwards');
  assert.equal(scheduleIndex('2026-10-16', '2026-10-16', 0), -1);
  assert.match(utcDate(new Date(Date.UTC(2026, 9, 16, 23, 59))), /^2026-10-16$/);
  assert.throws(() => dayNumber('not a date'));
});
