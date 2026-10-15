// Leaderboard worker tests, against an in-memory SQLite database standing in for D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { cleanName, validDate } from '../server/worker.js';

// the slice of the D1 API the worker uses: prepare(sql).bind(...).first() / all() / run()
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { stmt.run(...args); return { success: true }; },
      };
      return api;
    },
  };
}

const today = new Date().toISOString().slice(0, 10);
const env = () => ({ DB: fakeD1(), TOKEN_SALT: 'test-salt' });
const call = (e, method, path, body) => worker.fetch(new Request(`https://board.test${path}`, {
  method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), e).then(async (r) => ({ status: r.status, body: await r.json() }));

test('names are cleaned and capped', () => {
  assert.equal(cleanName('  Coach   <b>Belichick</b>!!  '), 'Coach bBelichickb');
  assert.equal(cleanName('x'.repeat(40)).length, 20);
  assert.equal(cleanName('<<>>'), null);
  assert.equal(cleanName(42), null);
});

test('only dates around today are accepted', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  assert.ok(validDate('2026-10-16', now));
  assert.ok(validDate('2026-10-15', now));
  assert.ok(validDate('2026-10-17', now));
  assert.ok(!validDate('2026-10-13', now));
  assert.ok(!validDate('16/10/2026', now));
});

test('the first finish of the day counts; a later post only adds a name', async () => {
  const e = env();
  const token = 'a'.repeat(32);
  let r = await call(e, 'POST', '/daily', { date: today, token, score: 71.4, win: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.n, 1);
  assert.equal(r.body.rank, 1);
  r = await call(e, 'POST', '/daily', { date: today, token, score: 99, win: true, name: 'Me' });
  assert.equal(r.body.n, 1);
  assert.equal(r.body.score, 71.4);
  assert.deepEqual(r.body.top, [{ name: 'Me', score: 71.4, win: 1 }]);
  await call(e, 'POST', '/daily', { date: today, token: 'b'.repeat(32), score: 90, win: false });
  r = await call(e, 'GET', `/daily?date=${today}`);
  assert.equal(r.body.n, 2);
  assert.equal(r.body.wins, 1);
  assert.equal(r.body.hist[7], 1);
  assert.equal(r.body.hist[9], 1);
});

test('bad input is rejected', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/daily', { date: today, token: 'short', score: 50 })).status, 400);
  assert.equal((await call(e, 'POST', '/daily', { date: today, token: 'c'.repeat(32), score: 150 })).status, 400);
  assert.equal((await call(e, 'POST', '/daily', { date: '2001-01-01', token: 'c'.repeat(32), score: 1 })).status, 400);
  assert.equal((await call(e, 'GET', '/nope')).status, 404);
});

test('survivor keeps each device\'s best run', async () => {
  const e = env();
  const token = 'd'.repeat(32);
  await call(e, 'POST', '/survivor', { token, name: 'Streaker', streak: 4 });
  let r = await call(e, 'POST', '/survivor', { token, name: 'Streaker', streak: 2 });
  assert.equal(r.body.best, 4);
  r = await call(e, 'POST', '/survivor', { token, name: 'Streaker', streak: 6 });
  assert.equal(r.body.best, 6);
  assert.deepEqual(r.body.top, [{ name: 'Streaker', best: 6 }]);
  assert.equal((await call(e, 'POST', '/survivor', { token, streak: 3 })).status, 400);
});
