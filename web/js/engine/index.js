// Public entry point of the engine. See docs/ENGINE.md.

import { loadLibrary } from './data.js';
import { scheduleIndex, seedOf, utcDate } from './rng.js';
import { EvalPool, defaultPoolSize } from './pool.js';
import { Game } from './game.js';
import { addMeasures, emptyMeasures, lookalike } from './grade.js';

export { Game } from './game.js';
export { GRADES, gradeOf } from './grade.js';
export { LOOKS } from './data.js';
export { clockText, downText, ballText } from './rules.js';
export { addDays, dayIndex, utcDate } from './rng.js';

const defaultFetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

/** The loaded data set plus the simulation worker pool; makes games. */
export class Engine {
  /**
   * Fetch calls, plays, special, coaches and spots/index, and start the worker pool.
   * @param {string} [baseUrl] URL of the data directory, with a trailing slash
   * @param {{fetchJson?: (url: string) => Promise<any>, workers?: number}} [opts]
   *   fetchJson: injectable loader (Node tests read files from disk);
   *   workers: pool size (default min(3, cores - 1), 2 on touch devices; 0 = in-thread)
   * @returns {Promise<Engine>}
   */
  static async load(baseUrl = 'data/', { fetchJson = defaultFetchJson, workers = defaultPoolSize() } = {}) {
    // The workers start loading their own copy of the data while this thread loads.
    const pool = new EvalPool(null, { baseUrl, size: workers });
    try {
      pool.lib = await loadLibrary(baseUrl, fetchJson);
    } catch (err) {
      pool.close();
      throw err;
    }
    return new Engine(pool.lib, { baseUrl, fetchJson, pool });
  }

  /**
   * @param {import('./data.js').Library} lib
   * @param {{baseUrl?: string, fetchJson?: Function, pool?: EvalPool}} [opts]
   */
  constructor(lib, { baseUrl = 'data/', fetchJson = defaultFetchJson, pool } = {}) {
    this.lib = lib;
    this.baseUrl = baseUrl;
    this.fetchJson = fetchJson;
    this.pool = pool || new EvalPool(lib, { size: 0 });
    this._spots = new Map();
  }

  /** spots/index.json */
  get spotIndex() {
    return this.lib.index;
  }

  /** The 26 calls of calls.json. */
  get calls() {
    return this.lib.calls;
  }

  /**
   * The daily spot id for a UTC date ('YYYY-MM-DD', default today): day d since launch plays
   * daily[d mod len], wrapping in both directions.
   */
  dailySpotId(date = utcDate()) {
    const idx = this.lib.index;
    const i = scheduleIndex(date, idx.launch, idx.daily.length);
    return i < 0 ? null : idx.daily[i];
  }

  /** Spot ids eligible for survivor mode. */
  survivorSpotIds() {
    return this.lib.index.survivor || [];
  }

  /**
   * Fetch a spot file (cached).
   * @param {string} id
   * @returns {Promise<object>}
   */
  async loadSpot(id) {
    if (!this._spots.has(id)) {
      this._spots.set(id, this.fetchJson(`${this.baseUrl}spots/${id}.json`).catch((err) => {
        this._spots.delete(id);
        throw err;
      }));
    }
    return this._spots.get(id);
  }

  /**
   * Start a game on a spot.
   * @param {object} spot spots/<id>.json
   * @param {{mode?: 'daily'|'survivor', seed?: number, tendencies?: string[],
   *   runs?: {r1?: number, r2?: number, after?: number}}} [opts]
   *   seed: everything random in the game (default: derived from the spot id, so every
   *   daily player gets the same draws for the same choices); tendencies: the user's recent
   *   call ids (the defense adapts its looks to them; persist game.tend across games);
   *   runs: simulations per option (defaults 400 / 2400 / 600)
   * @returns {Game}
   */
  newGame(spot, { mode = 'daily', seed, tendencies = [], runs } = {}) {
    const s = seed ?? (mode === 'survivor' ? Math.floor(Math.random() * 2 ** 32) : seedOf('daily', spot.id));
    return new Game(this, spot, { mode, seed: s, tendencies, runs });
  }

  /**
   * Restore a saved game (Game#toJSON output). Fetches the spot unless given.
   * @returns {Promise<Game>}
   */
  static async restore(eng, json, spot) {
    return Game.fromJSON(eng, json, spot || (await eng.loadSpot(json.spotId)));
  }

  /** Measure totals with nothing counted (for persisting look-alike data across days). */
  emptyMeasures() {
    return emptyMeasures();
  }

  /** Add two measure totals (pure). */
  addMeasures(a, b) {
    return addMeasures(a, b);
  }

  /** Nearest real coach for measure totals (see grade.lookalike). */
  lookalike(measures) {
    return lookalike(this.lib.coaches, measures);
  }

  /** Stop the worker pool. */
  close() {
    this.pool.close();
  }
}
