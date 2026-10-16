import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { EvalPool } from '../../web/js/engine/pool.js';
import { initialState } from '../../web/js/engine/rules.js';
import { buildContext } from '../../web/js/engine/resolve.js';
import { evaluate } from '../../web/js/engine/sim.js';
import { makeSpot, synthEngine } from '../fixtures/synth.js';

const { eng, files } = await synthEngine();
const lib = eng.lib;

/** A Web Worker look-alike backed by a Node worker thread. */
class ShimWorker {
  constructor(url) {
    this.thread = new ThreadWorker(new URL('../fixtures/worker-shim.mjs', import.meta.url), { workerData: { url: url.href } });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (err) => this.onerror?.(err));
  }

  postMessage(msg) {
    this.thread.postMessage(msg);
  }

  terminate() {
    this.thread.terminate();
  }
}

/** Serve the synthetic data files over HTTP (the workers fetch them). */
async function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url.slice(1));
    if (!(path in files)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(files[path]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('worker pool gives exactly the in-thread results, split by option or by run', async () => {
  const { server, url } = await serve();
  globalThis.Worker = ShimWorker;
  const pool = new EvalPool(lib, { baseUrl: url, size: 2 });
  try {
    assert.equal(pool.size, 2);
    const spot = makeSpot();
    const ctx = buildContext(spot);
    const s = initialState(spot);
    const opts = ['short_r', 'run_middle', 'deep_l', 'screen', 'pa_short', 'rollout'].map((id) => ({
      kind: 'offense', a: { type: 'play', call: lib.callId(id), tempo: 'hurry', timeout: false, oob: false }, look: 0,
    }));
    const many = await pool.evaluate(ctx, s, opts, { n: 120, seed: 3 });
    assert.deepEqual(Array.from(many), Array.from(evaluate(lib, ctx, s, opts, { n: 120, seed: 3 })));
    const few = await pool.evaluate(ctx, s, opts.slice(0, 1), { n: 120, seed: 3 });
    assert.ok(Math.abs(few[0] - many[0]) < 1e-12, 'splitting one option across workers by runs');
  } finally {
    pool.close();
    delete globalThis.Worker;
    server.close();
  }
});

test('the pool falls back to this thread when the workers cannot load', async () => {
  globalThis.Worker = ShimWorker;
  const pool = new EvalPool(lib, { baseUrl: 'http://127.0.0.1:9/', size: 2 });
  try {
    const spot = makeSpot();
    const ctx = buildContext(spot);
    const s = initialState(spot);
    const opts = [{ kind: 'policy' }];
    const v = await pool.evaluate(ctx, s, opts, { n: 60, seed: 4 });
    assert.equal(pool.size, 0);
    assert.deepEqual(Array.from(v), Array.from(evaluate(lib, ctx, s, opts, { n: 60, seed: 4 })));
  } finally {
    pool.close();
    delete globalThis.Worker;
  }
});
