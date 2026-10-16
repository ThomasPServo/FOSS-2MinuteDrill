// Synthetic data set in the DATA.md format, for engine unit tests that must not depend on
// the real pipeline output. The numbers are plausible NFL-like values, not real data.

import { Rng } from '../../web/js/engine/rng.js';

const call = (id, label, family, kind, dir, say, depth) => ({ id, label, family, kind, dir, say, ...(depth ? { depth } : {}) });

/** The 26 calls in the order of pipeline/calls.py (the call index). */
export const CALLS = [
  call('run_out_l', 'Outside run left', 'run', 'run', 'left', 'runs outside to the left'),
  call('run_tackle_l', 'Off tackle left', 'run', 'run', 'left', 'runs off left tackle'),
  call('run_guard_l', 'Inside run left', 'run', 'run', 'left', 'runs inside behind the left guard'),
  call('run_middle', 'Up the middle', 'run', 'run', 'middle', 'runs up the middle'),
  call('run_guard_r', 'Inside run right', 'run', 'run', 'right', 'runs inside behind the right guard'),
  call('run_tackle_r', 'Off tackle right', 'run', 'run', 'right', 'runs off right tackle'),
  call('run_out_r', 'Outside run right', 'run', 'run', 'right', 'runs outside to the right'),
  call('qb_run', 'QB run', 'run', 'run', null, 'keeps it on a designed QB run'),
  call('qb_sneak', 'QB sneak', 'run', 'run', 'middle', 'sneaks it'),
  call('short_l', 'Short pass left', 'pass', 'pass', 'left', 'throws short to the left', 'short'),
  call('short_m', 'Short pass middle', 'pass', 'pass', 'middle', 'throws short over the middle', 'short'),
  call('short_r', 'Short pass right', 'pass', 'pass', 'right', 'throws short to the right', 'short'),
  call('deep_l', 'Deep pass left', 'pass', 'pass', 'left', 'goes deep down the left side', 'deep'),
  call('deep_m', 'Deep pass middle', 'pass', 'pass', 'middle', 'goes deep down the middle', 'deep'),
  call('deep_r', 'Deep pass right', 'pass', 'pass', 'right', 'goes deep down the right side', 'deep'),
  call('screen', 'Screen pass', 'pass', 'pass', null, 'throws a screen', 'screen'),
  call('pa_short', 'Play-action short', 'pass', 'pass', null, 'fakes the handoff and throws short', 'short'),
  call('pa_deep', 'Play-action deep', 'pass', 'pass', null, 'fakes the handoff and goes deep', 'deep'),
  call('rollout', 'QB rollout', 'pass', 'pass', null, 'rolls out and throws', 'short'),
  call('hail_mary', 'Hail Mary', 'pass', 'pass', null, 'heaves a Hail Mary', 'hail'),
  call('rpo_run', 'RPO keep/give', 'rpo', 'run', null, 'reads the defense and hands it off'),
  call('rpo_pass', 'RPO throw', 'rpo', 'pass', null, 'reads the defense and throws', 'short'),
  call('end_around', 'End-around', 'trick', 'run', null, 'hands it to a receiver on an end-around'),
  call('direct_snap', 'Direct snap', 'trick', 'run', null, 'snaps it directly to a runner'),
  call('receiver_pass', 'Trick pass', 'trick', 'pass', null, 'lets a non-quarterback throw it', 'deep'),
  call('flea_flicker', 'Flea flicker', 'trick', 'pass', null, 'runs the flea flicker', 'deep'),
];

// Relative frequency of each call in ordinary situations.
const CALL_WEIGHT = [4, 4, 5, 6, 5, 4, 4, 1.5, 1, 8, 8, 8, 2.5, 1.5, 2.5, 4, 3, 1.5, 2, 0.3, 2, 2, 0.3, 0.2, 0.2, 0.2];

function modeOf(h2, hs, margin) {
  if (!h2) return hs <= 120 ? 1 : 0;
  if ((margin < 0 && hs <= 300) || (margin === 0 && hs <= 120) || (margin <= -9 && hs <= 600)) return 1;
  if (margin > 0 && hs <= 360) return 2;
  return 0;
}

function pickWeighted(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let t = rng.float() * total;
  for (let i = 0; i < weights.length; i++) {
    t -= weights[i];
    if (t < 0) return i;
  }
  return weights.length - 1;
}

/** One synthetic snap of `c` at a situation; returns the column values. */
function synthPlay(rng, c, sit) {
  const k = CALLS[c];
  const { yl, ytg } = sit;
  let yds = 0;
  let fl = 0;
  let tov = 0;
  let air = 0;
  let tgt = 1;
  let dur = 5 + rng.float() * 2;
  const r = rng.float();
  const passLike = k.kind === 'pass';
  if (rng.float() < 0.06) {
    const pen = [-10, -5, 5, 15][rng.int(4)];
    yds = pen;
    fl |= 1 | 2048;
    if (pen === 15) fl |= 2;
    dur = 4;
  } else if (!passLike) {
    tgt = k.id.startsWith('qb') ? 0 : k.id === 'end_around' ? 2 : 1;
    if (r < 0.012) {
      fl |= 128;
      yds = Math.round(rng.normal() * 2 + 2);
      tov = yds + rng.int(5);
    } else {
      yds = Math.round(4 + rng.normal() * 4);
      if (rng.float() < 0.05) yds += 10 + rng.int(40);
      if (k.id === 'qb_sneak') yds = Math.round(1.5 + rng.normal() * 1.5);
      if ((k.dir === 'left' || k.dir === 'right') && rng.float() < 0.12) fl |= 8;
    }
  } else {
    tgt = 2 + rng.int(2);
    const deep = k.depth === 'deep' || k.depth === 'hail';
    const comp = k.id === 'hail_mary' ? 0.1 : k.id === 'screen' ? 0.8 : deep ? 0.4 : 0.66;
    if (r < 0.065) {
      fl |= 512;
      yds = -Math.round(5 + rng.float() * 5);
      tgt = 0;
    } else if (r < 0.065 + (deep ? 0.04 : 0.02)) {
      fl |= 64;
      air = deep ? 25 : 8;
      tov = air - rng.int(15);
      if (rng.float() < 0.1) fl |= 32;
    } else if (r < 0.1 + comp * 0.9) {
      air = deep ? 15 + rng.int(25) : k.id === 'screen' ? -2 : 3 + rng.int(8);
      yds = Math.max(-3, Math.round(air + Math.abs(rng.normal()) * 5));
      if (k.id === 'hail_mary') yds = Math.max(yds, 40);
      if (rng.float() < 0.18) fl |= 8;
    } else if (r < 0.13 + comp * 0.9) {
      fl |= 1024;
      yds = Math.round(5 + rng.float() * 8);
      tgt = 0;
    } else {
      fl |= 4;
      air = deep ? 25 : 7;
      dur = 4 + rng.float();
    }
  }
  if (!(fl & (64 | 128 | 2048))) {
    if (yds >= yl) {
      yds = yl;
      fl |= 16;
    } else if (yl - yds >= 100) {
      fl |= 256;
    }
  }
  if (fl & 2048 && yds > 0) yds = Math.min(yds, yl - 1);
  if ((yds >= ytg && !(fl & (4 | 64 | 128))) || (fl & 2)) fl |= 4096;
  const epa = Math.round(100 * ((fl & 16 ? 4 : 0) + (yds - (ytg <= 3 ? 2 : 4)) * 0.12 - (fl & (64 | 128) ? 4 : 0) - (fl & 4 ? 0.5 : 0)));
  const look = pickWeighted(rng, [0.42, 0.24, 0.14, 0.2]);
  return { yds, fl, tov, air, tgt, dur: Math.round(dur * 10), epa, look, loc: k.dir === 'left' ? 0 : k.dir === 'right' ? 2 : 1 };
}

/** Synthetic plays.json with `n` snaps (plus a few hundred two-point tries). */
export function makePlays(n = 30000, seed = 7) {
  const rng = new Rng(seed);
  const cols = {
    call: [], g: [], pid: [], down: [], ytg: [], yl: [], mode: [], hs: [], margin: [],
    yds: [], dur: [], fl: [], tov: [], epa: [], look: [], air: [], loc: [], tgt: [], two: [],
  };
  const games = ['2023_05_KC_MIN', '2024_10_NO_ATL', '2024_18_BUF_MIA'];
  const push = (c, sit, p, two) => {
    cols.call.push(c);
    cols.g.push(rng.int(games.length));
    cols.pid.push(100 + cols.call.length);
    cols.down.push(sit.down);
    cols.ytg.push(sit.ytg);
    cols.yl.push(sit.yl);
    cols.mode.push(sit.mode);
    cols.hs.push(sit.hs);
    cols.margin.push(sit.margin);
    for (const key of ['yds', 'dur', 'fl', 'tov', 'epa', 'look', 'air', 'loc', 'tgt']) cols[key].push(p[key]);
    cols.two.push(two ? 1 : 0);
  };
  for (let i = 0; i < n; i++) {
    const down = 1 + pickWeighted(rng, [0.4, 0.3, 0.25, 0.05]);
    const yl = 1 + rng.int(99);
    const ytg = Math.min(yl, down === 1 ? 10 : 1 + rng.int(15));
    const h2 = rng.float() < 0.5;
    const hs = rng.int(1800);
    const margin = rng.int(33) - 16;
    const mode = modeOf(h2, hs, margin);
    const weights = CALL_WEIGHT.slice();
    if (mode === 2) for (let c = 0; c <= 8; c++) weights[c] *= 3;
    if (mode === 1) for (let c = 9; c <= 18; c++) weights[c] *= 3;
    if (hs > 30) weights[19] = 0.02;
    if (ytg > 3) weights[8] = 0.05;
    const c = pickWeighted(rng, weights);
    push(c, { down, ytg, yl, mode, hs, margin }, synthPlay(rng, c, { yl, ytg }), false);
  }
  for (let i = 0; i < 600; i++) {
    const c = pickWeighted(rng, CALL_WEIGHT.map((w, j) => (j === 19 || j >= 22 ? 0 : w)));
    push(c, { down: 0, ytg: 2, yl: 2, mode: 0, hs: 600, margin: 0 }, synthPlay(rng, c, { yl: 2, ytg: 2 }), true);
  }
  return { version: 1, n: cols.call.length, games, cols };
}

/** Synthetic special.json. */
export function makeSpecial(seed = 11) {
  const rng = new Rng(seed);
  const punt = { yl: [], recv_yl: [], fl: [] };
  for (let i = 0; i < 3000; i++) {
    const yl = 30 + rng.int(70);
    let f = 0;
    let recv;
    const net = Math.round(42 + rng.normal() * 7);
    if (rng.float() < 0.008) {
      f = 1;
      recv = Math.max(1, 100 - yl - 8);
    } else if (yl - net <= 0 || rng.float() < 0.08 && yl < 55) {
      f = 2;
      recv = 80;
    } else {
      recv = 100 - (yl - net);
      if (rng.float() < 0.35) f |= 16;
    }
    if (rng.float() < 0.005) f |= 4;
    if (rng.float() < 0.01 && !(f & 4)) f |= 8;
    punt.yl.push(yl);
    punt.recv_yl.push(Math.min(99, Math.max(1, recv)));
    punt.fl.push(f);
  }
  const kickoff = { recv_yl: [], fl: [] };
  for (let i = 0; i < 2000; i++) {
    if (rng.float() < 0.6) {
      kickoff.recv_yl.push(65);
      kickoff.fl.push(2);
    } else {
      kickoff.recv_yl.push(Math.min(85, Math.max(55, Math.round(70 + rng.normal() * 6))));
      kickoff.fl.push(rng.float() < 0.005 ? 4 : 0);
    }
  }
  const pct = (lo, hi) => Array.from({ length: 19 }, (_, i) => Math.round((lo + ((hi - lo) * (i + 1)) / 20) * 10) / 10);
  const row = (fn) => Array.from({ length: 41 }, (_, i) => fn(i - 20));
  const chart = new Set([-2, -5, -9, -10, -13, 1, 5]);
  return {
    version: 1,
    fg: { features: ['const', 'dist', 'dist2', 'indoor', 'wind'], coef: [6.44, -0.0867, -0.04, 0.1, -0.02], blocked: 0.012, n: 4000 },
    xp: { rate: 0.95, blocked: 0.01, n: 5000 },
    two: { rate: 0.48, n: 500 },
    punt: { cols: punt },
    kickoff: { cols: kickoff, seasons: [2025, 2026] },
    onside: { rate: 0.08, n: 60 },
    between: { hurry: pct(6, 24), normal: pct(22, 39), kill: pct(34, 40) },
    dur: { run: 4.6, pass: 6.1, sack: 5.5, incomplete: 4.4, kneel: 1.5, spike: 1.0 },
    fourth: null,
    go2: { margins: [-20, 20], rows: { early: row((m) => (chart.has(m) ? 0.25 : 0.03)), late: row((m) => (chart.has(m) ? 0.7 : 0.05)) } },
    halftime_wp: { features: ['const', 'margin', 'receive2h', 'spread'], coef: [0, 0.15, 0.1, 0.05] },
    league: { epa_sd_pass: 1.5, epa_sd_run: 1.1 },
  };
}

const player = (id, name, pos, r, num) => ({ id, name, short: `${name[0]}.${name.split(' ')[1]}`, pos, num, r, spd: 9 });

function lineup(prefix, base) {
  const off = [
    player(`${prefix}1`, `${prefix} Quarterback`, 'QB', base + 10, 15),
    player(`${prefix}2`, `${prefix} Runner`, 'RB', base, 25),
    player(`${prefix}3`, `${prefix} Wideone`, 'WR', base + 5, 11),
    player(`${prefix}4`, `${prefix} Widetwo`, 'WR', base, 12),
    player(`${prefix}5`, `${prefix} Slot`, 'WR', base - 5, 13),
    player(`${prefix}6`, `${prefix} Tightend`, 'TE', base, 87),
    ...['T', 'G', 'C', 'G', 'T'].map((p, i) => player(`${prefix}o${i}`, `${prefix} Lineman${i}`, p, base, 70 + i)),
  ];
  const def = [
    ...['DE', 'DT', 'DT', 'DE'].map((p, i) => player(`${prefix}d${i}`, `${prefix} Front${i}`, p, base, 90 + i)),
    ...['OLB', 'ILB', 'OLB'].map((p, i) => player(`${prefix}l${i}`, `${prefix} Backer${i}`, p, base, 50 + i)),
    ...['CB', 'CB', 'FS', 'SS'].map((p, i) => player(`${prefix}b${i}`, `${prefix} Back${i}`, p, base, 20 + i)),
  ];
  return { off, def, k: player(`${prefix}k`, `${prefix} Kicker`, 'K', 75, 3), p: player(`${prefix}p`, `${prefix} Punter`, 'P', 70, 4), subs: [] };
}

/**
 * A synthetic spot file.
 * @param {object} o overrides: id, cat, team, start fields
 */
export function makeSpot(o = {}) {
  const home = o.home || 'NO';
  const away = o.away || 'KC';
  const team = o.team || away;
  const start = {
    qtr: 4, clock: 118, score: { [away]: 20, [home]: 23 }, pos: team, down: 1, ytg: 10, yl: 75,
    to: { [away]: 2, [home]: 3 }, receive2h: home, phase: 'snap', ...(o.start || {}),
  };
  return {
    version: 1,
    id: o.id || `2024_05_${away}_${home}_3456`,
    cat: o.cat || 'drill',
    game_id: `2024_05_${away}_${home}`,
    play_id: 3456,
    season: 2024, week: 5, type: o.type || 'REG', date: '2024-10-07',
    home, away, team,
    roof: 'dome', indoor: true, temp: 72, wind: 0, spread: o.spread ?? -2.5,
    start,
    real: {
      coach: { [away]: 'Away Coach', [home]: 'Home Coach' }, call: 'short_r',
      drive: o.drive || 'Touchdown', final: o.final || { [away]: 27, [home]: 23 },
      desc: '(1:58) P.Quarterback pass short right to W.Wideone for 8 yards',
    },
    strength: {
      [away]: { off_pass: 0.05, off_rush: -0.02, def_pass: -0.01, def_rush: 0.03 },
      [home]: { off_pass: 0.0, off_rush: 0.01, def_pass: 0.02, def_rush: -0.01 },
    },
    players: { [away]: lineup(away, 75), [home]: lineup(home, 70) },
  };
}

/** Spots used by the tests (one per category, plus a Q4 survivor spot). */
export function makeSpots() {
  return [
    makeSpot({ id: 'drill1', cat: 'drill' }),
    makeSpot({ id: 'protect1', cat: 'protect', team: 'NO', start: { pos: 'NO', score: { KC: 17, NO: 21 }, clock: 240, yl: 60 } }),
    makeSpot({ id: 'tight1', cat: 'tight', start: { qtr: 2, clock: 95, score: { KC: 10, NO: 10 }, yl: 70 } }),
    makeSpot({ id: 'q41', cat: 'q4', start: { clock: 420, score: { KC: 14, NO: 21 }, yl: 70 } }),
  ];
}

/** coaches.json */
export function makeCoaches() {
  return {
    version: 1,
    measures: ['pass', 'deep', 'go', 'two'],
    league: { pass: { mean: 0.62, sd: 0.05 }, deep: { mean: 0.15, sd: 0.03 }, go: { mean: 0.35, sd: 0.1 }, two: { mean: 0.12, sd: 0.06 } },
    coaches: [
      { name: 'Air Raid', teams: ['KC'], from: 2022, to: 2026, n: 500, pass: 0.72, deep: 0.2, go: 0.5, two: 0.2 },
      { name: 'Ground Pound', teams: ['NO'], from: 2022, to: 2026, n: 450, pass: 0.52, deep: 0.1, go: 0.25, two: 0.05 },
      { name: 'Middle Road', teams: ['BUF'], from: 2022, to: 2026, n: 400, pass: 0.62, deep: 0.15, go: 0.35, two: 0.12 },
    ],
  };
}

/** The whole data set as a map from file path (relative to the data dir) to parsed JSON. */
export function makeDataFiles({ plays = 30000 } = {}) {
  const spots = makeSpots();
  const files = {
    'calls.json': { version: 1, calls: CALLS },
    'plays.json': makePlays(plays),
    'special.json': makeSpecial(),
    'coaches.json': makeCoaches(),
    'spots/index.json': {
      version: 1,
      launch: '2026-10-16',
      categories: { drill: 'Two-minute drill', protect: 'Protect the lead', tight: 'Tied, or the end of the half', q4: 'Fourth quarter' },
      spots: spots.map((s) => ({ id: s.id, cat: s.cat, season: s.season, week: s.week, type: s.type, date: s.date, home: s.home, away: s.away, team: s.team, qtr: s.start.qtr, clock: s.start.clock, score: s.start.score, yl: s.start.yl })),
      daily: ['drill1', 'protect1', 'tight1'],
      survivor: ['q41'],
    },
  };
  for (const s of spots) files[`spots/${s.id}.json`] = s;
  return files;
}

/** A fetchJson for Engine.load that serves the in-memory files (base URL 'mem/'). */
export function memoryFetch(files) {
  return async (url) => {
    const path = url.replace(/^mem\//, '');
    if (!(path in files)) throw new Error(`404 ${url}`);
    return JSON.parse(JSON.stringify(files[path]));
  };
}

let cached = null;

/**
 * The synthetic data set loaded through Engine.load (in-thread evaluation), built once per
 * test process.
 * @returns {Promise<{eng: import('../../web/js/engine/index.js').Engine, files: object}>}
 */
export async function synthEngine() {
  if (!cached) {
    const { Engine } = await import('../../web/js/engine/index.js');
    const files = makeDataFiles();
    cached = Engine.load('mem/', { fetchJson: memoryFetch(files), workers: 0 }).then((eng) => ({ eng, files }));
  }
  return cached;
}
