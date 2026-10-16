// Loading and indexing of the data files described in docs/DATA.md.
//
// The play library (plays.json) is columnar. It is copied into typed arrays and indexed
// into *base buckets* by (call, situation key). A situation key packs the game mode, down
// bucket, distance bucket and field zone into one integer 0..251. Draw pools are unions of
// base buckets, widened until they hold enough plays. Each pool caches the cumulative
// weights of its tilted distributions (one Float64Array per tilt), so a draw is one
// binary search.

export const N_KEYS = 252;                      // 3 modes x 3 downs x 4 distances x 7 zones
export const MIN_POOL = 40;                     // fewest plays in a draw pool
export const MIN_LOOK_POOL = 40;                // fewest plays in a look-filtered pool
export const MIN_MIX = 150;                     // fewest plays behind a call mix
export const OOB_BOOST = 3;                     // "get out of bounds": weight of plays that ended OOB
export const PLAY_CLOCK = 40;                   // most seconds that can run between snaps
export const MODE = { NORMAL: 0, HURRY: 1, KILL: 2 };
export const LOOKS = ['base', 'blitz', 'load', 'soft'];   // plays.json `look` 0..3

/**
 * Dropback families. The pipeline labels a pass by where it was thrown, so sacks and
 * scrambles (no throw, no location) all land in one catch-all call per family: `short_m`
 * for straight dropbacks, `pa_short` for play action. The engine pools them as the
 * family's "pressure" outcome, which every call of the family meets at the family's rate.
 */
const FAMILIES = [
  { catchAll: 'short_m', calls: ['short_l', 'short_m', 'short_r', 'deep_l', 'deep_m', 'deep_r'] },
  { catchAll: 'pa_short', calls: ['pa_short', 'pa_deep'] },
];

/** Flag bits of plays.json `fl`. */
export const FL = {
  PEN: 1, AUTO1: 2, INC: 4, OOB: 8, TD: 16, DEFTD: 32, INT: 64, FUM: 128,
  SAFETY: 256, SACK: 512, SCRAMBLE: 1024, NOPLAY: 2048, FIRST: 4096,
};

/** Punt `fl` bits (special.json). */
export const PUNT_FL = { BLOCKED: 1, TOUCHBACK: 2, RET_TD: 4, KICK_REC: 8, DOWNED: 16 };
/** Kickoff `fl` bits (special.json). */
export const KO_FL = { TOUCHBACK: 2, RET_TD: 4, KICK_REC: 8, OOB: 16 };

export const zoneOf = (yl) => (yl <= 3 ? 0 : yl <= 10 ? 1 : yl <= 20 ? 2 : yl <= 40 ? 3 : yl <= 60 ? 4 : yl <= 80 ? 5 : 6);
export const distOf = (ytg) => (ytg <= 2 ? 0 : ytg <= 5 ? 1 : ytg <= 10 ? 2 : 3);
export const downOf = (down) => (down <= 1 ? 0 : down === 2 ? 1 : 2);

/**
 * Game-situation mode at a snap (DATA.md): 1 hurry, 2 kill, 0 normal.
 * @param {boolean} secondHalf second half or overtime
 * @param {number} hs seconds left in the half (overtime: in the period)
 * @param {number} margin offense score minus defense score
 */
export function gameMode(secondHalf, hs, margin) {
  if (!secondHalf) return hs <= 120 ? MODE.HURRY : MODE.NORMAL;
  if ((margin < 0 && hs <= 300) || (margin === 0 && hs <= 120) || (margin <= -9 && hs <= 600)) return MODE.HURRY;
  if (margin > 0 && hs <= 360) return MODE.KILL;
  return MODE.NORMAL;
}

/** Situation key 0..251 from mode, down, yards to go and yard line. */
export const sitKey = (mode, down, ytg, yl) => ((mode * 3 + downOf(down)) * 4 + distOf(ytg)) * 7 + zoneOf(yl);

/** Unpack a situation key into its bucket indices. */
export function keyParts(key) {
  return { zone: key % 7, dist: Math.floor(key / 7) % 4, down: Math.floor(key / 28) % 3, mode: Math.floor(key / 84) };
}

const keyOf = (mode, down, dist, zone) => ((mode * 3 + down) * 4 + dist) * 7 + zone;
const span = (center, radius, n) => {
  const out = [];
  for (let i = Math.max(0, center - radius); i <= Math.min(n - 1, center + radius); i++) out.push(i);
  return out;
};
const ALL_MODES = [0, 1, 2];
const ALL_DOWNS = [0, 1, 2];
const ALL_DISTS = [0, 1, 2, 3];
const ALL_ZONES = [0, 1, 2, 3, 4, 5, 6];

function cross(modes, downs, dists, zones) {
  const keys = [];
  for (const m of modes) for (const d of downs) for (const t of dists) for (const z of zones) keys.push(keyOf(m, d, t, z));
  return keys;
}

/**
 * Widening levels for play pools (ENGINE.md): exact situation, ignore mode, neighbouring
 * distances, any down, neighbouring zones, any distance, zones +-2, the whole call.
 */
function poolLevels(key) {
  const { down, dist, zone } = keyParts(key);
  const d1 = span(dist, 1, 4);
  return [
    [key],
    cross(ALL_MODES, [down], [dist], [zone]),
    cross(ALL_MODES, [down], d1, [zone]),
    cross(ALL_MODES, ALL_DOWNS, d1, [zone]),
    cross(ALL_MODES, ALL_DOWNS, d1, span(zone, 1, 7)),
    cross(ALL_MODES, ALL_DOWNS, ALL_DISTS, span(zone, 1, 7)),
    cross(ALL_MODES, ALL_DOWNS, ALL_DISTS, span(zone, 2, 7)),
    cross(ALL_MODES, ALL_DOWNS, ALL_DISTS, ALL_ZONES),
  ];
}

/** Widening levels for call mixes and look frequencies: the mode is kept as long as possible. */
function mixLevels(key) {
  const { mode, down, dist, zone } = keyParts(key);
  return [
    [key],
    cross([mode], [down], span(dist, 1, 4), [zone]),
    cross([mode], [down], span(dist, 1, 4), span(zone, 1, 7)),
    cross([mode], ALL_DOWNS, span(dist, 1, 4), span(zone, 1, 7)),
    cross([mode], ALL_DOWNS, ALL_DISTS, ALL_ZONES),
    cross(ALL_MODES, ALL_DOWNS, ALL_DISTS, ALL_ZONES),
  ];
}

const toTyped = (Type, values, n) => {
  const out = new Type(n);
  if (values) for (let i = 0; i < n; i++) out[i] = values[i];
  return out;
};

/** A draw pool: a set of play indices with cached tilted CDFs. */
class Pool {
  constructor(lib, idx, level) {
    this.idx = idx;
    this.n = idx.length;
    this.level = level;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < this.n; i++) {
      const e = lib.epa[idx[i]];
      s += e;
      s2 += e * e;
    }
    this.mean = this.n ? s / this.n : 0;
    this.sd = this.n > 1 ? Math.max(0.3, Math.sqrt(Math.max(0, s2 / this.n - this.mean * this.mean))) : 1;
    this.cdfs = new Map();
  }
}

/** The indexed data set: calls, play library, kicking/clock/policy models, coaches. */
export class Library {
  /**
   * @param {{calls: object, plays: object, special: object, coaches?: object, index?: object}} json
   *   the parsed data files (DATA.md)
   */
  constructor(json) {
    this.special = json.special;
    this.coaches = json.coaches || null;
    this.index = json.index || null;
    this._initCalls(json.calls.calls);
    this._initPlays(json.plays);
    this._initSpecial(json.special);
  }

  _initCalls(calls) {
    this.calls = calls;
    this.nCalls = calls.length;
    this.callIndex = new Map(calls.map((c, i) => [c.id, i]));
    this.isPass = Uint8Array.from(calls, (c) => (c.kind === 'pass' ? 1 : 0));
    this.isTrick = Uint8Array.from(calls, (c) => (c.family === 'trick' ? 1 : 0));
    this.isDeep = Uint8Array.from(calls, (c) => (c.depth === 'deep' || c.depth === 'hail' ? 1 : 0));
    this.hail = this.callIndex.has('hail_mary') ? this.callIndex.get('hail_mary') : -1;
    this.sneak = this.callIndex.has('qb_sneak') ? this.callIndex.get('qb_sneak') : -1;
    // Dropback family of each call (-1: none) and each family's catch-all call.
    this.families = FAMILIES.filter((f) => this.callIndex.has(f.catchAll));
    this.family = new Int8Array(this.nCalls).fill(-1);
    this.catchAll = this.families.map((f, k) => {
      for (const id of f.calls) if (this.callIndex.has(id)) this.family[this.callIndex.get(id)] = k;
      return this.callIndex.get(f.catchAll);
    });
    // Pools are indexed by "bucket calls": the real calls, then one pressure pool per family.
    this.nBuckets = this.nCalls + this.families.length;
  }

  /** Is play `i` a sack or scramble filed under its family's catch-all call? */
  _isPressure(i) {
    const f = this.family[this.call[i]];
    return f >= 0 && this.catchAll[f] === this.call[i] && (this.fl[i] & (FL.SACK | FL.SCRAMBLE)) !== 0;
  }

  _initPlays(plays) {
    const n = plays.n ?? plays.cols.call.length;
    const c = plays.cols;
    this.n = n;
    this.games = plays.games || [];
    this.call = toTyped(Uint8Array, c.call, n);
    this.g = toTyped(Int32Array, c.g, n);
    this.pid = toTyped(Int32Array, c.pid, n);
    this.down = toTyped(Int8Array, c.down, n);
    this.ytg = toTyped(Int16Array, c.ytg, n);
    this.yl = toTyped(Int16Array, c.yl, n);
    this.mode = toTyped(Int8Array, c.mode, n);
    this.hs = toTyped(Int16Array, c.hs, n);
    this.margin = toTyped(Int16Array, c.margin, n);
    this.yds = toTyped(Int16Array, c.yds, n);
    this.dur = toTyped(Int16Array, c.dur, n);
    this.fl = toTyped(Int32Array, c.fl, n);
    this.tov = toTyped(Int16Array, c.tov, n);
    this.epa = new Float32Array(n);
    for (let i = 0; i < n; i++) this.epa[i] = (c.epa?.[i] ?? 0) / 100;
    this.look = toTyped(Int8Array, c.look, n);
    this.air = toTyped(Int16Array, c.air, n);
    this.loc = toTyped(Int8Array, c.loc, n);
    this.tgt = toTyped(Int8Array, c.tgt, n);
    this.two = toTyped(Int8Array, c.two, n);

    // Base buckets: (bucket call, situation key) for ordinary snaps.
    const nf = this.families.length;
    const nb = this.nBuckets * N_KEYS;
    const count = new Int32Array(nb + 1);
    const bucket = new Int32Array(n).fill(-1);
    this.keyCounts = new Float64Array(N_KEYS * this.nCalls);    // (key, call) play counts
    this.lookCounts = new Int32Array(N_KEYS * 4);               // (key, look) play counts
    this.pressureCounts = new Int32Array(nf * N_KEYS);          // (family, key) sacks + scrambles
    this.familyCounts = new Int32Array(nf * N_KEYS);            // (family, key) other dropbacks
    const twoByCall = Array.from({ length: this.nBuckets }, () => []);
    const goalByCall = Array.from({ length: this.nBuckets }, () => []);
    for (let i = 0; i < n; i++) {
      const call = this.call[i];
      const f = this.family[call];
      const bcall = this._isPressure(i) ? this.nCalls + f : call;
      if (this.two[i]) {
        twoByCall[bcall].push(i);
        continue;
      }
      const yl = Math.min(99, Math.max(1, this.yl[i]));
      const key = sitKey(this.mode[i], this.down[i], Math.max(1, this.ytg[i]), yl);
      const b = bcall * N_KEYS + key;
      bucket[i] = b;
      count[b + 1]++;
      if (bcall >= this.nCalls) this.pressureCounts[f * N_KEYS + key]++;
      else {
        this.keyCounts[key * this.nCalls + call]++;
        if (f >= 0) this.familyCounts[f * N_KEYS + key]++;
      }
      if (this.look[i] >= 0 && this.look[i] < 4) this.lookCounts[key * 4 + this.look[i]]++;
      if (yl <= 5 && this.ytg[i] >= yl) goalByCall[bcall].push(i);
    }
    // The NFL call mix: a sack or scramble was a call of its family (we do not know which),
    // so its count is shared out in proportion to the family's other plays.
    for (let key = 0; key < N_KEYS; key++) {
      for (let f = 0; f < nf; f++) {
        const p = this.pressureCounts[f * N_KEYS + key];
        if (!p) continue;
        const own = this.familyCounts[f * N_KEYS + key];
        for (const id of this.families[f].calls) {
          const c = this.callIndex.get(id);
          if (c === undefined) continue;
          const share = own ? this.keyCounts[key * this.nCalls + c] / own : (c === this.catchAll[f] ? 1 : 0);
          this.keyCounts[key * this.nCalls + c] += p * share;
        }
      }
    }
    for (let b = 0; b < nb; b++) count[b + 1] += count[b];
    this.bStart = count;
    this.order = new Int32Array(count[nb]);
    const fill = count.slice(0, nb);
    for (let i = 0; i < n; i++) if (bucket[i] >= 0) this.order[fill[bucket[i]]++] = i;

    this._pools = new Array(nb);
    this._lookPools = new Array(nb * 4);
    this._twoPools = new Array(this.nBuckets);
    this._twoSource = { two: twoByCall, goal: goalByCall };
    this._mixes = new Array(N_KEYS);
    this._lookMixes = new Array(N_KEYS);
    this._pressureRates = new Array(nf * N_KEYS);
    this._twoMix = null;
  }

  /**
   * Share of a dropback family's snaps that ended in a sack or scramble in a situation
   * (widened like the call mixes until MIN_MIX snaps).
   * @param {number} f family index (this.family[call])
   * @param {number} key situation key
   */
  pressureRate(f, key) {
    const id = f * N_KEYS + key;
    let rate = this._pressureRates[id];
    if (rate === undefined) {
      let p = 0;
      let all = 0;
      for (const keys of mixLevels(key)) {
        p = 0;
        all = 0;
        for (const k of keys) {
          p += this.pressureCounts[f * N_KEYS + k];
          all += this.pressureCounts[f * N_KEYS + k] + this.familyCounts[f * N_KEYS + k];
        }
        if (all >= MIN_MIX) break;
      }
      rate = all ? p / all : 0;
      this._pressureRates[id] = rate;
    }
    return rate;
  }

  /** Pool of a family's sacks and scrambles in a situation. */
  pressurePool(f, key) {
    return this.pool(this.nCalls + f, key);
  }

  /** Share of a family's two-point tries that ended in a sack or scramble. */
  twoPressureRate(f) {
    const p = this._twoSource.two[this.nCalls + f].length;
    let all = p;
    for (const id of this.families[f].calls) if (this.callIndex.has(id)) all += this._twoSource.two[this.callIndex.get(id)].length;
    return all ? p / all : 0;
  }

  /**
   * Draw pool for a call in a situation: with the family's pressure rate (uniform `u`),
   * the family's sacks and scrambles; otherwise the call's own plays, restricted to the
   * defense's look when it is known (`look` >= 0) and the look pool is big enough.
   */
  drawPool(call, key, look, u) {
    const f = this.family[call];
    if (f >= 0 && u < this.pressureRate(f, key)) return this.pressurePool(f, key);
    return (look >= 0 && this.lookPool(call, key, look)) || this.pool(call, key);
  }

  /** Two-point draw pool for a call (pressure mixed in as for drawPool). */
  twoDrawPool(call, u) {
    const f = this.family[call];
    if (f >= 0 && u < this.twoPressureRate(f)) return this.twoPool(this.nCalls + f);
    return this.twoPool(call);
  }

  _initSpecial(sp) {
    this.between = {};
    for (const t of ['hurry', 'normal', 'kill']) this.between[t] = Float64Array.from(sp.between?.[t] || [5, 40]);
    this.durs = { run: 4.5, pass: 6, sack: 5.5, incomplete: 4.5, kneel: 1.5, spike: 1, ...(sp.dur || {}) };

    const punt = sp.punt?.cols || { yl: [], recv_yl: [], fl: [] };
    this.punt = { yl: Int16Array.from(punt.yl), recv: Int16Array.from(punt.recv_yl), fl: Int16Array.from(punt.fl) };
    let blocked = 0;
    const blockedIdx = [];
    for (let i = 0; i < this.punt.yl.length; i++) {
      if (this.punt.fl[i] & PUNT_FL.BLOCKED) {
        blocked++;
        blockedIdx.push(i);
      }
    }
    this.punt.blockRate = this.punt.yl.length ? blocked / this.punt.yl.length : 0.008;
    this.punt.blockedIdx = Int32Array.from(blockedIdx);
    this._puntPools = new Array(100);

    const ko = sp.kickoff?.cols || { recv_yl: [65], fl: [KO_FL.TOUCHBACK] };
    this.kickoff = { recv: Int16Array.from(ko.recv_yl), fl: Int16Array.from(ko.fl) };
  }

  /** Call index of an id (throws on unknown ids). */
  callId(id) {
    const i = this.callIndex.get(id);
    if (i === undefined) throw new Error(`unknown call: ${id}`);
    return i;
  }

  /**
   * The draw pool for a call in a situation, widened until it holds MIN_POOL plays.
   * @param {number} call call index
   * @param {number} key situation key
   * @returns {Pool}
   */
  pool(call, key) {
    const id = call * N_KEYS + key;
    let pool = this._pools[id];
    if (!pool) {
      const levels = poolLevels(key);
      pool = this._buildPool(call, levels, () => true, MIN_POOL)
        || this._buildPool(call, levels.slice(-1), () => true, 1)
        || new Pool(this, new Int32Array(0), levels.length);
      this._pools[id] = pool;
    }
    return pool;
  }

  /**
   * The pool of plays of `call` that met defensive look `look`, widened until it holds
   * MIN_LOOK_POOL plays; null when even the whole call has too few.
   */
  lookPool(call, key, look) {
    const id = (call * N_KEYS + key) * 4 + look;
    let pool = this._lookPools[id];
    if (pool === undefined) {
      pool = this._buildPool(call, poolLevels(key), (i) => this.look[i] === look, MIN_LOOK_POOL);
      this._lookPools[id] = pool;
    }
    return pool;
  }

  _buildPool(call, levels, keep, min) {
    for (let level = 0; level < levels.length; level++) {
      let total = 0;
      for (const key of levels[level]) {
        const b = call * N_KEYS + key;
        for (let j = this.bStart[b]; j < this.bStart[b + 1]; j++) if (keep(this.order[j])) total++;
      }
      if (total < min) continue;
      const idx = new Int32Array(total);
      let k = 0;
      for (const key of levels[level]) {
        const b = call * N_KEYS + key;
        for (let j = this.bStart[b]; j < this.bStart[b + 1]; j++) if (keep(this.order[j])) idx[k++] = this.order[j];
      }
      return new Pool(this, idx, level);
    }
    return null;
  }

  /**
   * Two-point pool of a call: its real two-point tries, widened with goal-to-go snaps
   * inside the 3, then inside the 5, then the call's red-zone pool.
   */
  twoPool(call) {
    let pool = this._twoPools[call];
    if (!pool) {
      const two = this._twoSource.two[call];
      const goal = this._twoSource.goal[call];
      let idx = two;
      if (idx.length < MIN_POOL) idx = two.concat(goal.filter((i) => this.yl[i] <= 3));
      if (idx.length < MIN_POOL) idx = two.concat(goal);
      pool = idx.length >= MIN_POOL
        ? new Pool(this, Int32Array.from(idx), 0)
        : this.pool(call, sitKey(MODE.NORMAL, 3, 2, 2));
      this._twoPools[call] = pool;
    }
    return pool;
  }

  /**
   * Cumulative weights of a pool tilted by `w = exp(k * epa)`, with out-of-bounds plays
   * weighted x OOB_BOOST when `oob`. Cached per (pool, k rounded to 1/4096, oob).
   */
  cdf(pool, k, oob) {
    const kq = Math.round(k * 4096);
    const id = kq * 2 + (oob ? 1 : 0);
    let cdf = pool.cdfs.get(id);
    if (!cdf) {
      const kk = kq / 4096;
      cdf = new Float64Array(pool.n);
      let acc = 0;
      for (let i = 0; i < pool.n; i++) {
        const p = pool.idx[i];
        let w = kk ? Math.exp(kk * this.epa[p]) : 1;
        if (oob && (this.fl[p] & FL.OOB)) w *= OOB_BOOST;
        acc += w;
        cdf[i] = acc;
      }
      pool.cdfs.set(id, cdf);
    }
    return cdf;
  }

  /**
   * Draw a play index from a pool.
   * @param {Pool} pool
   * @param {number} k exponential tilt on EPA
   * @param {boolean} oob favour plays that ended out of bounds (x OOB_BOOST)
   * @param {number} u uniform in [0, 1)
   */
  draw(pool, k, oob, u) {
    if (!pool.n) return -1;
    if (Math.round(k * 4096) === 0 && !oob) return pool.idx[Math.min(pool.n - 1, Math.floor(u * pool.n))];
    const cdf = this.cdf(pool, k, oob);
    const target = u * cdf[pool.n - 1];
    let lo = 0;
    let hi = pool.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] > target) hi = mid;
      else lo = mid + 1;
    }
    return pool.idx[lo];
  }

  _sumCounts(keys, counts, width) {
    const out = new Float64Array(width);
    let total = 0;
    for (const key of keys) {
      for (let j = 0; j < width; j++) {
        const v = counts[key * width + j];
        out[j] += v;
        total += v;
      }
    }
    return { out, total };
  }

  /**
   * NFL call mix of a situation key (play counts per call, widened until MIN_MIX plays).
   * `freq` is normalised over all calls; `cum` is the cumulative weight used by the
   * policy, which never samples the Hail Mary from the mix.
   */
  mix(key) {
    let mix = this._mixes[key];
    if (!mix) {
      let res = null;
      for (const keys of mixLevels(key)) {
        res = this._sumCounts(keys, this.keyCounts, this.nCalls);
        if (res.total >= MIN_MIX) break;
      }
      const freq = new Float64Array(this.nCalls);
      const cum = new Float64Array(this.nCalls);
      let acc = 0;
      for (let c = 0; c < this.nCalls; c++) {
        freq[c] = res.total ? res.out[c] / res.total : 1 / this.nCalls;
        if (c !== this.hail) acc += freq[c];
        cum[c] = acc;
      }
      mix = { freq, cum, total: acc };
      this._mixes[key] = mix;
    }
    return mix;
  }

  /** NFL frequencies of the four defensive looks in a situation. */
  lookMix(key) {
    let mix = this._lookMixes[key];
    if (!mix) {
      let res = null;
      for (const keys of mixLevels(key)) {
        res = this._sumCounts(keys, this.lookCounts, 4);
        if (res.total >= MIN_MIX) break;
      }
      mix = Float64Array.from(res.out, (v) => (res.total ? v / res.total : 0.25));
      this._lookMixes[key] = mix;
    }
    return mix;
  }

  /** Share of the plays of a pool that met each look (4 numbers). */
  lookShares(pool) {
    if (!pool.lookShares) {
      const s = new Float64Array(4);
      for (let i = 0; i < pool.n; i++) {
        const lk = this.look[pool.idx[i]];
        if (lk >= 0 && lk < 4) s[lk]++;
      }
      const total = s[0] + s[1] + s[2] + s[3];
      for (let j = 0; j < 4; j++) s[j] = total ? s[j] / total : 0.25;
      pool.lookShares = s;
    }
    return pool.lookShares;
  }

  /**
   * NFL call mix on two-point tries (counts of real tries per call, sacks and scrambles
   * shared out within their family).
   */
  twoMix() {
    if (!this._twoMix) {
      const two = this._twoSource.two;
      const freq = new Float64Array(this.nCalls);
      const cum = new Float64Array(this.nCalls);
      for (let c = 0; c < this.nCalls; c++) freq[c] = c === this.hail || this.isTrick[c] ? 0 : two[c].length + 0.5;
      this.families.forEach((fam, f) => {
        const ids = fam.calls.filter((id) => this.callIndex.has(id)).map((id) => this.callIndex.get(id));
        const own = ids.reduce((s, c) => s + freq[c], 0);
        for (const c of ids) freq[c] += (two[this.nCalls + f].length * freq[c]) / own;
      });
      let total = 0;
      for (let c = 0; c < this.nCalls; c++) total += freq[c];
      let acc = 0;
      for (let c = 0; c < this.nCalls; c++) {
        freq[c] /= total;
        acc += freq[c];
        cum[c] = acc;
      }
      this._twoMix = { freq, cum, total: acc };
    }
    return this._twoMix;
  }

  /**
   * Seconds that run off between snaps with the clock running, drawn from the
   * special.between percentiles (5th..95th, linearly extrapolated to the tails).
   * @param {'hurry'|'normal'|'kill'} tempo
   * @param {number} u uniform in [0, 1)
   */
  runoff(tempo, u) {
    const q = this.between[tempo] || this.between.normal;
    const m = q.length;
    if (m === 1) return q[0];
    const pos = u * (m + 1) - 1;
    let v;
    if (pos <= 0) v = q[0] + pos * (q[1] - q[0]);
    else if (pos >= m - 1) v = q[m - 1] + (pos - m + 1) * (q[m - 1] - q[m - 2]);
    else {
      const i = Math.floor(pos);
      v = q[i] + (pos - i) * (q[i + 1] - q[i]);
    }
    return Math.min(PLAY_CLOCK, Math.max(1, v));
  }

  /**
   * Field-goal make probability (special.fg logistic, `dist = yl + 18`). The fit has few
   * kicks beyond 60 yards and flattens there, so the logit tapers by 0.12 per yard past 56
   * and the chance fades to zero between 66 and 70 yards (the NFL record is 66).
   * @param {number} yl
   * @param {{indoor?: boolean, wind?: number}} weather
   * @param {number} [shift] logit shift (kicker rating, fire drill)
   */
  fgProb(yl, weather, shift = 0) {
    const dist = yl + 18;
    if (dist >= 70) return 0;
    const fg = this.special.fg;
    const indoor = weather.indoor ? 1 : 0;
    const feats = {
      const: 1, dist, dist2: (dist * dist) / 100, indoor, wind: indoor ? 0 : weather.wind || 0,
    };
    let z = shift - 0.12 * Math.max(0, dist - 56);
    fg.features.forEach((f, i) => { z += (fg.coef[i] || 0) * (feats[f] ?? 0); });
    const p = 1 / (1 + Math.exp(-z));
    return dist > 66 ? (p * (70 - dist)) / 4 : p;
  }

  /** Punts from within +-w yards of `yl` (w = 5, 10, ... until 30 punts), cached per yard line. */
  puntPool(yl) {
    const y = Math.min(99, Math.max(1, Math.round(yl)));
    let pool = this._puntPools[y];
    if (!pool) {
      const n = this.punt.yl.length;
      let all = [];
      for (let w = 5; w <= 100; w += 5) {
        all = [];
        for (let i = 0; i < n; i++) if (Math.abs(this.punt.yl[i] - y) <= w) all.push(i);
        if (all.length >= 30) break;
      }
      const clean = all.filter((i) => !(this.punt.fl[i] & PUNT_FL.BLOCKED));
      pool = { all: Int32Array.from(all), clean: Int32Array.from(clean.length ? clean : all) };
      this._puntPools[y] = pool;
    }
    return pool;
  }

  /**
   * Fourth-down choice probabilities [go, fg, punt] from the special.fourth multinomial
   * logit, or null if the model is missing or uses a feature this engine does not know.
   * @param {Record<string, number>} feats feature values by name
   */
  fourthProbs(feats) {
    const m = this.special.fourth;
    if (!m || !m.features || !m.coef) return null;
    const classes = m.classes || ['go', 'fg', 'punt'];
    const z = new Float64Array(classes.length);
    for (let k = 0; k < classes.length; k++) {
      let s = 0;
      for (let f = 0; f < m.features.length; f++) {
        const w = m.coef[k]?.[f] || 0;
        if (!w) continue;
        const v = feats[m.features[f]];
        if (v === undefined) return null;
        s += w * v;
      }
      z[k] = s;
    }
    let max = -Infinity;
    for (const v of z) max = Math.max(max, v);
    let total = 0;
    for (let k = 0; k < z.length; k++) total += (z[k] = Math.exp(z[k] - max));
    const out = { go: 0, fg: 0, punt: 0 };
    classes.forEach((c, k) => { out[c] = z[k] / total; });
    return out;
  }

  /** Share of NFL touchdowns followed by a two-point try (special.go2). */
  go2Rate(margin, late) {
    const g = this.special.go2;
    if (!g || !g.rows) return Math.abs(margin) <= 16 && [-2, -5, -9, -10, 1, 5].includes(margin) ? 0.6 : 0.05;
    const row = (late ? g.rows.late : g.rows.early) || g.rows.early || [];
    if (!row.length) return 0.05;
    const i = Math.min(row.length - 1, Math.max(0, Math.round(margin - g.margins[0])));
    return row[i];
  }

  /**
   * Halftime win probability (special.halftime_wp) for a team.
   * @param {number} margin the team's margin
   * @param {number} receive2h 1 if it receives the second-half kickoff
   * @param {number} spread the team's point spread (positive = favoured)
   */
  halftimeWp(margin, receive2h, spread) {
    const m = this.special.halftime_wp;
    const feats = { const: 1, margin, receive2h, spread };
    let z = 0;
    if (m && m.features) m.features.forEach((f, i) => { z += (m.coef[i] || 0) * (feats[f] ?? 0); });
    else z = 0.15 * margin + 0.1 * receive2h + 0.06 * spread;
    return 1 / (1 + Math.exp(-z));
  }

  /** Real-game provenance of a play: nflverse game id, play id, season, week, teams. */
  provenance(i) {
    const gameId = this.games[this.g[i]] || '';
    const [season, week, away, home] = gameId.split('_');
    return { gameId, pid: this.pid[i], season: Number(season) || null, week: Number(week) || null, away: away || null, home: home || null };
  }
}

/**
 * Fetch and index the data set.
 * @param {string} baseUrl directory holding the data files (with trailing slash)
 * @param {(url: string) => Promise<any>} fetchJson
 */
export async function loadLibrary(baseUrl, fetchJson) {
  const [calls, plays, special, coaches, index] = await Promise.all(
    ['calls.json', 'plays.json', 'special.json', 'coaches.json', 'spots/index.json'].map((f) => fetchJson(baseUrl + f)),
  );
  return new Library({ calls, plays, special, coaches, index });
}
