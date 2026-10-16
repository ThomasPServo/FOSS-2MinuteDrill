// A small pool of module Web Workers that run the simulator (sim.js). Each worker loads
// the data set once; the first one starts at once and the others when it is ready, so they
// read the data from the HTTP cache. An evaluation is split into jobs by option, or by runs when there are
// few options; because every run's random stream depends only on (seed, run, event), the
// result is identical however the work is split. Without Worker support (Node, old
// browsers) or if the workers fail to load, evaluations run in this thread.

import { evaluateSums } from './sim.js';

/** Default pool size: min(3, cores - 1), 2 on touch devices, 0 without Worker support. */
export function defaultPoolSize() {
  if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return 0;
  const cores = navigator.hardwareConcurrency || 2;
  const touch = navigator.maxTouchPoints > 0;
  return Math.max(1, Math.min(touch ? 2 : 3, cores - 1));
}

const isBrowser = typeof window !== 'undefined';
const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs simulations in workers when possible, in this thread otherwise. */
export class EvalPool {
  /**
   * @param {import('./data.js').Library|null} lib the main-thread library for the in-thread
   *   fallback (may be set later, before the first evaluation)
   * @param {{baseUrl?: string, size?: number}} [opts] data URL for the workers, pool size
   */
  constructor(lib, { baseUrl = 'data/', size = defaultPoolSize() } = {}) {
    this.lib = lib;
    this.slots = [];
    this.queue = [];
    this.nextId = 1;
    this.toSpawn = 0;
    if (size > 0 && typeof Worker !== 'undefined') {
      this.href = typeof location !== 'undefined' ? new URL(baseUrl, location.href).href : baseUrl;
      this.toSpawn = size - 1;
      this._spawn();
    }
  }

  /** Number of live (or starting) workers; 0 means in-thread evaluation. */
  get size() {
    return this.slots.filter((s) => !s.dead).length + this.toSpawn;
  }

  _spawn() {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      return;
    }
    const slot = { worker, ready: false, dead: false, job: null };
    worker.onmessage = (e) => this._onMessage(slot, e.data);
    worker.onerror = () => this._fail(slot);
    worker.postMessage({ type: 'init', baseUrl: this.href });
    this.slots.push(slot);
  }

  /** Start the remaining workers (after the first one has loaded, or failed). */
  _spawnRest() {
    for (; this.toSpawn > 0; this.toSpawn--) this._spawn();
  }

  _onMessage(slot, msg) {
    if (msg.type === 'ready') {
      slot.ready = true;
      this._spawnRest();
      this._pump();
    } else if (msg.type === 'result' && slot.job && slot.job.id === msg.id) {
      const job = slot.job;
      slot.job = null;
      job.resolve(msg.sums);
      this._pump();
    } else if (msg.type === 'error') {
      this._fail(slot);
    }
  }

  _fail(slot) {
    if (slot.dead) return;
    slot.dead = true;
    slot.worker.terminate();
    if (!this.slots.some((s) => s.ready)) this.toSpawn = 0;   // the data cannot load: give up
    if (slot.job) {
      this.queue.unshift(slot.job);
      slot.job = null;
    }
    this._pump();
  }

  _pump() {
    if (!this.size) {
      // No workers left: run whatever is queued here.
      const jobs = this.queue.splice(0);
      for (const job of jobs) this._runLocal(job.msg).then(job.resolve, job.reject);
      return;
    }
    for (const slot of this.slots) {
      if (!slot.ready || slot.dead || slot.job || !this.queue.length) continue;
      const job = this.queue.shift();
      slot.job = job;
      slot.worker.postMessage({ type: 'eval', id: job.id, ...job.msg });
    }
  }

  async _runLocal(msg) {
    if (!isBrowser) return evaluateSums(this.lib, msg.ctx, msg.state, msg.options, msg);
    const sums = new Float64Array(msg.options.length);
    for (let j = 0; j < msg.options.length; j++) {
      await yieldToUi();
      sums[j] = evaluateSums(this.lib, msg.ctx, msg.state, [msg.options[j]], msg)[0];
    }
    return sums;
  }

  _submit(msg) {
    if (!this.size) return this._runLocal(msg);
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, msg, resolve, reject });
      this._pump();
    });
  }

  /**
   * The user's mean result after each option over `n` simulated games.
   * @param {object} ctx game context (resolve.buildContext)
   * @param {object} state the state before the decision
   * @param {object[]} options internal options (sim.applyOption)
   * @param {{n: number, seed: number}} o
   * @returns {Promise<Float64Array>}
   */
  async evaluate(ctx, state, options, { n, seed }) {
    if (!options.length) return new Float64Array(0);
    const workers = Math.max(1, this.size);
    const jobs = [];
    if (options.length >= 2 * workers || workers === 1) {
      const per = Math.ceil(options.length / (workers === 1 ? 1 : 2 * workers));
      for (let i = 0; i < options.length; i += per) jobs.push({ first: i, options: options.slice(i, i + per), start: 0, n });
    } else {
      const parts = Math.ceil((2 * workers) / options.length);
      const per = Math.ceil(n / parts);
      options.forEach((opt, i) => {
        for (let start = 0; start < n; start += per) jobs.push({ first: i, options: [opt], start, n: Math.min(per, n - start) });
      });
    }
    const results = await Promise.all(jobs.map((j) => this._submit({ ctx, state, options: j.options, n: j.n, seed, start: j.start })));
    const sums = new Float64Array(options.length);
    jobs.forEach((j, k) => results[k].forEach((v, i) => { sums[j.first + i] += v; }));
    return sums.map((v) => v / n);
  }

  /** Stop the workers. */
  close() {
    for (const slot of this.slots) {
      if (!slot.dead) slot.worker.terminate();
      slot.dead = true;
    }
  }
}
