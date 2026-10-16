// Seeded randomness, string hashing and the UTC date helpers behind the daily schedule.
//
// The generator is xoshiro128** (Blackman & Vigna, public domain): four 32-bit words of
// state, fast with Math.imul, and good enough for Monte Carlo. Seeding goes through a
// splitmix-style avalanche so that nearby seeds (run 41, run 42, ...) give unrelated
// streams. `reseed(a, b, c)` re-initialises a generator in place from three integers,
// which is how the simulator gets common random numbers: the stream for (seed, run, event)
// is the same whichever option is being evaluated.

const DAY_MS = 86400000;

/** A 32-bit avalanche ("lowbias32" by Chris Wellons). */
export function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d);
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Hash any number of integers into one unsigned 32-bit integer. */
export function hashInts(...values) {
  let h = 0x9e3779b9;
  for (const v of values) h = mix32((h ^ mix32((v | 0) + 0x632be5ab)) + 0x6d2b79f5);
  return h >>> 0;
}

/**
 * cyrb53: a fast 53-bit string hash (public domain, bryc).
 * @param {string} str
 * @param {number} [seed]
 * @returns {number} an integer in [0, 2^53)
 */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Hash a string (or a list of parts joined with '|') to an unsigned 32-bit seed. */
export function seedOf(...parts) {
  return cyrb53(parts.join('|')) % 4294967296 >>> 0;
}

const rotl = (x, k) => (x << k) | (x >>> (32 - k));

/** xoshiro128** pseudo-random generator. */
export class Rng {
  /** @param {...number} seed one or more integers */
  constructor(...seed) {
    this.s0 = 0; this.s1 = 0; this.s2 = 0; this.s3 = 0;
    this.reseed(...(seed.length ? seed : [0]));
  }

  /** Re-initialise in place from up to three integers (cheap: no allocation). */
  reseed(a = 0, b = 0, c = 0) {
    let h = hashInts(a, b, c);
    this.s0 = h = mix32(h + 0x9e3779b9);
    this.s1 = h = mix32(h + 0x9e3779b9);
    this.s2 = h = mix32(h + 0x9e3779b9);
    this.s3 = mix32(h + 0x9e3779b9) | 1;
    return this;
  }

  /** Next unsigned 32-bit integer. */
  u32() {
    const s1 = this.s1;
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  float() {
    return this.u32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo, hi) {
    return lo + (hi - lo) * this.float();
  }

  /** Uniform integer in [0, n). */
  int(n) {
    return Math.floor(this.float() * n);
  }

  /** Standard normal draw (Box-Muller). */
  normal() {
    const u = 1 - this.float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.float());
  }

  /** A new independent generator derived from this one's next output and `parts`. */
  derive(...parts) {
    return new Rng(this.u32(), hashInts(...parts));
  }
}

/**
 * Random numbers for the simulator, addressed by (run, event, slot) instead of drawn in
 * sequence. Each purpose (runoff, play call, play draw, kick, coin toss, ...) has its own
 * slot, so two options compared with the same seed see the same uniform for the same
 * purpose even when one of them skips a draw (common random numbers).
 */
export class Draws {
  /** @param {number} seed @param {number} [run] @param {number} [event] */
  constructor(seed = 0, run = 0, event = 0) {
    this.seed = seed >>> 0;
    this.run = run;
    this.event = event;
  }

  /** Point at another run / event (no allocation). */
  set(run, event) {
    this.run = run;
    this.event = event;
    return this;
  }

  /** Uniform in [0, 1) for a slot of the current event. */
  u(slot) {
    return hashInts(this.seed, this.run, this.event * 32 + slot) / 4294967296;
  }

  /** Uniform in [lo, hi) for a slot. */
  range(slot, lo, hi) {
    return lo + (hi - lo) * this.u(slot);
  }
}

/** Slots of Draws used by the engine. */
export const SLOT = {
  RUNOFF: 0, CALL: 1, FOURTH: 2, PLAY: 3, PICK: 4, ROUGH: 5, PAT: 6, TOSS: 7, TWO_CALL: 8, LOOK: 9, PRESSURE: 10,
};

/** Days since 1970-01-01 (UTC) of a 'YYYY-MM-DD' string. */
export function dayNumber(date) {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`bad date: ${date}`);
  return Math.round(t / DAY_MS);
}

/** Today's UTC date as 'YYYY-MM-DD'. */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Add whole days to a 'YYYY-MM-DD' string. */
export function addDays(date, days) {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `launch` to `date` (negative before launch). */
export function dayIndex(date, launch) {
  return dayNumber(date) - dayNumber(launch);
}

/** Index into a schedule of `length` entries for `date`, wrapping in both directions. */
export function scheduleIndex(date, launch, length) {
  if (!length) return -1;
  const d = dayIndex(date, launch);
  return ((d % length) + length) % length;
}
