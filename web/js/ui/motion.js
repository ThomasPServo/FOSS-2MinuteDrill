// Player motion: per-group acceleration/braking/turning envelopes, planned paths that
// respect them, and simple steering for everyone else. Units are yards and seconds.
// Positions are field coordinates: x across (0..53.3), y = L (yards from the user's goal).

// Measured envelopes from public player tracking (top speed yd/s, accel a0 - k·v, brake,
// lateral). Top speed is replaced by the player's own NGS top speed when we have it.
const ENVELOPES = {
  WR: [9.66, 8.11, 0.728, 4.35, 5.32],
  CB: [9.62, 6.48, 0.528, 4.23, 4.95],
  RB: [9.51, 6.85, 0.597, 3.91, 4.81],
  S: [9.30, 6.59, 0.558, 4.38, 5.09],
  LB: [8.63, 6.29, 0.562, 3.69, 4.64],
  TE: [8.56, 6.51, 0.597, 3.59, 4.59],
  QB: [7.83, 5.16, 0.430, 2.45, 4.65],
  DL: [6.98, 4.79, 0.384, 2.80, 3.95],
  OL: [6.32, 3.51, 0.260, 2.00, 2.74],
};

export const DT = 0.05;
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hyp = Math.hypot;

/** A moving body with its group's envelope. `spd` (yd/s) overrides the group top speed. */
export function makeBody(id, group, x, y, { spd = null, jitter = 0 } = {}) {
  const [top, a0, k, brake, lat] = ENVELOPES[group] || ENVELOPES.LB;
  const own = spd && spd > 4 && spd < 12 ? spd : top;
  return {
    id, group, x, y, vx: 0, vy: 0,
    top: own * (1 + jitter), a0, k, brake, lat,
    legs: [], track: [],
  };
}

const accel = (b, v, e = 1) => Math.max(0.4, (b.a0 - b.k * v) * Math.sqrt(e));

// --- planned paths ----------------------------------------------------------------------------

function mergeClose(points) {
  const out = [points[0]];
  for (const p of points.slice(1)) {
    const q = out[out.length - 1];
    if (hyp(p[0] - q[0], p[1] - q[1]) >= 0.3) out.push(p);
  }
  return out;
}

/** Round corners into short curves; sharp reversals stay as stop-and-turn points. */
function roundCorners(points) {
  const out = [points[0]];
  const stops = new Set();
  for (let i = 1; i < points.length - 1; i += 1) {
    const [a, p, c] = [points[i - 1], points[i], points[i + 1]];
    const l1 = hyp(p[0] - a[0], p[1] - a[1]);
    const l2 = hyp(c[0] - p[0], c[1] - p[1]);
    const d1 = [(p[0] - a[0]) / l1, (p[1] - a[1]) / l1];
    const d2 = [(c[0] - p[0]) / l2, (c[1] - p[1]) / l2];
    const theta = Math.acos(clip(d1[0] * d2[0] + d1[1] * d2[1], -1, 1));
    if (theta < 0.005) continue;
    if (theta > 2.6) { stops.add(out.length); out.push(p); continue; }
    const wide = Math.max(18 * Math.tan(theta / 2), 2.3);
    const tl = Math.min(0.45 * l1, 0.45 * l2, 2.3 + (wide - 2.3) * clip((0.8 - theta) / 0.5, 0, 1));
    const s0 = [p[0] - d1[0] * tl, p[1] - d1[1] * tl];
    const s1 = [p[0] + d2[0] * tl, p[1] + d2[1] * tl];
    for (let j = 0; j <= 6; j += 1) {
      const t = j / 6;
      const m = (1 - t) * (1 - t);
      const n = 2 * t * (1 - t);
      const q = t * t;
      out.push([m * s0[0] + n * p[0] + q * s1[0], m * s0[1] + n * p[1] + q * s1[1]]);
    }
  }
  out.push(points[points.length - 1]);
  return { pts: out, stops };
}

/** Resample a polyline every `ds` yards; returns { xs, ys, stopAt: Set of sample indices }. */
function resample({ pts, stops }, ds = 0.1) {
  const xs = [pts[0][0]];
  const ys = [pts[0][1]];
  const stopAt = new Set();
  let carry = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = hyp(bx - ax, by - ay);
    let s = ds - carry;
    while (s <= len) {
      xs.push(ax + ((bx - ax) * s) / len);
      ys.push(ay + ((by - ay) * s) / len);
      s += ds;
    }
    carry = len - (s - ds);
    if (stops.has(i)) stopAt.add(xs.length - 1);
  }
  const lx = pts[pts.length - 1];
  if (hyp(lx[0] - xs[xs.length - 1], lx[1] - ys[ys.length - 1]) > 1e-6) { xs.push(lx[0]); ys.push(lx[1]); }
  return { xs, ys, stopAt };
}

/** Speed profile and timing along a resampled path at effort e. */
function profile(b, path, e, { v0 = 0, vEnd = null } = {}) {
  const { xs, ys, stopAt } = path;
  const n = xs.length;
  const ds = new Float64Array(n);
  for (let i = 1; i < n; i += 1) ds[i] = hyp(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const top = b.top * e;
  const cap = new Float64Array(n).fill(top);
  for (let i = 4; i < n - 4; i += 1) {
    // circumradius through samples i-4, i, i+4 caps the speed on curves
    const ax = xs[i - 4]; const ay = ys[i - 4]; const bx = xs[i]; const by = ys[i]; const cx = xs[i + 4]; const cy = ys[i + 4];
    const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (area2 < 1e-6) continue;
    const r = (hyp(bx - ax, by - ay) * hyp(cx - bx, cy - by) * hyp(cx - ax, cy - ay)) / (2 * area2);
    cap[i] = Math.min(top, Math.sqrt(b.lat * r));
  }
  for (const i of stopAt) cap[i] = 0.4;
  const v = new Float64Array(n);
  v[0] = Math.min(v0, top);
  for (let i = 1; i < n; i += 1) {
    v[i] = Math.min(cap[i], top, Math.sqrt(v[i - 1] ** 2 + 2 * accel(b, v[i - 1], e) * ds[i]));
  }
  if (vEnd != null) v[n - 1] = Math.min(v[n - 1], vEnd);
  for (let i = n - 2; i >= 0; i -= 1) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * 0.85 * b.brake * ds[i + 1]));
  const t = new Float64Array(n);
  for (let i = 1; i < n; i += 1) t[i] = t[i - 1] + ds[i] / Math.max(0.05, (v[i - 1] + v[i]) / 2);
  return { xs, ys, v, t, duration: t[n - 1] };
}

/**
 * Plan a path through waypoints [[x, y], ...] starting from rest (or `v0`). With `arrive`
 * set, the effort is tuned so the body gets there at that time (late if it can't).
 */
export function plan(b, waypoints, { arrive = null, v0 = 0, vEnd = null, maxEffort = 1 } = {}) {
  const pts = mergeClose(waypoints);
  if (pts.length < 2) {
    const [x, y] = pts[0];
    return { xs: [x], ys: [y], v: [0], t: [0], duration: 0 };
  }
  const path = resample(roundCorners(pts));
  let best = profile(b, path, maxEffort, { v0, vEnd });
  if (arrive == null || best.duration >= arrive) return best;
  let lo = 0.12;
  let hi = maxEffort;
  for (let i = 0; i < 18; i += 1) {
    const mid = (lo + hi) / 2;
    const p = profile(b, path, mid, { v0, vEnd });
    if (p.duration > arrive) lo = mid;
    else { hi = mid; best = p; }
  }
  return best;
}

/** Position and velocity on a planned path at time tau after it starts. */
function samplePlan(p, tau) {
  const { t, xs, ys, v } = p;
  const n = t.length;
  if (tau <= 0 || n === 1) return [xs[0], ys[0], 0, 0];
  if (tau >= t[n - 1]) {
    // carry the end speed along the last direction so a following leg starts moving
    const dx = xs[n - 1] - xs[n - 2];
    const dy = ys[n - 1] - ys[n - 2];
    const d = hyp(dx, dy) || 1;
    return [xs[n - 1], ys[n - 1], (dx / d) * v[n - 1], (dy / d) * v[n - 1]];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tau) lo = mid; else hi = mid;
  }
  const f = (tau - t[lo]) / (t[hi] - t[lo]);
  const dt = t[hi] - t[lo];
  return [xs[lo] + (xs[hi] - xs[lo]) * f, ys[lo] + (ys[hi] - ys[lo]) * f, (xs[hi] - xs[lo]) / dt, (ys[hi] - ys[lo]) / dt];
}

// --- steering -----------------------------------------------------------------------------------

/** Move a body one tick toward a desired velocity, within its envelope. */
function steer(b, dvx, dvy, dt = DT, effort = 1) {
  const v = hyp(b.vx, b.vy);
  const want = hyp(dvx, dvy);
  const top = b.top * effort;
  if (want > top) { dvx *= top / want; dvy *= top / want; }
  if (v > 2.5 && want > 0.01) {
    // brake before cutting
    const f = clip(0.35 + 0.65 * ((b.vx * dvx + b.vy * dvy) / (v * want)), 0.12, 1);
    dvx *= f;
    dvy *= f;
  }
  if (v < 0.35) {
    let cx = dvx - b.vx;
    let cy = dvy - b.vy;
    const c = hyp(cx, cy);
    const m = Math.max(b.a0, b.brake) * dt;
    if (c > m) { cx *= m / c; cy *= m / c; }
    b.vx += cx;
    b.vy += cy;
  } else {
    const ux = b.vx / v;
    const uy = b.vy / v;
    const tangential = clip(dvx * ux + dvy * uy - v, -b.brake * dt, accel(b, v) * dt);
    const normalMax = Math.max(b.lat, 7 - v) * dt;
    const normal = clip(dvx * -uy + dvy * ux, -normalMax, normalMax);
    const vt = Math.max(0, v + tangential);
    b.vx = ux * vt - uy * normal;
    b.vy = uy * vt + ux * normal;
  }
  const sp = hyp(b.vx, b.vy);
  if (sp > b.top) { b.vx *= b.top / sp; b.vy *= b.top / sp; }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

/** Desired velocity to arrive at (x, y) and stop there. */
function goToward(b, x, y, effort = 1) {
  const dx = x - b.x;
  const dy = y - b.y;
  const d = hyp(dx, dy);
  if (d < 0.05) return [0, 0];
  const sp = Math.min(b.top * effort, Math.sqrt(1.4 * b.brake * d), 4 * d);
  return [(dx / d) * sp, (dy / d) * sp];
}

/** Desired velocity to chase a moving point with lead, optionally holding a gap. */
function chase(b, tx, ty, tvx, tvy, { lead = 1, gap = 0, effort = 1 } = {}) {
  const d0 = hyp(tx - b.x, ty - b.y);
  const look = clip(d0 / b.top, 0, 1.4) * lead;
  let ax = tx + tvx * look;
  let ay = ty + tvy * look;
  if (gap > 0) {
    const d = hyp(ax - b.x, ay - b.y) || 1;
    ax -= ((ax - b.x) / d) * gap;
    ay -= ((ay - b.y) / d) * gap;
  }
  return goToward(b, ax, ay, effort);
}

// --- the world ----------------------------------------------------------------------------------

/**
 * A world of bodies, each following timed legs { at, kind, ... }:
 *   path   { plan }                         follow a planned path (plan starts at `at`)
 *   go     { x, y, effort? }                run to a point and stop
 *   chase  { target, lead?, gap?, effort? } pursue another body
 *   block  { target, guard, dist? }         stay between body `target` and body `guard`
 *   rush   { target, blockers }             go at a body; held up by blockers on contact
 *   mirror { target, dx, dy, lag }          man coverage: shadow a receiver's recent spot + offset
 *   stick  { target, dx, dy }               stay at an offset from another body
 *   stand  {}                               stop
 * run(until) can be called in stages, adding legs in between (e.g. once a pass is caught).
 * Each body's .track collects [x, y] per DT tick.
 */
export class World {
  constructor(bodies) {
    this.bodies = bodies;
    this.byId = new Map(bodies.map((b) => [b.id, b]));
    this.t = 0;
  }

  /** Add a leg to a body, keeping its legs in time order. */
  leg(b, leg) {
    b.legs.push(leg);
    b.legs.sort((a, c) => a.at - c.at);
  }

  run(until) {
    while (this.t < until - 1e-9) {
      for (const b of this.bodies) b.track.push(b.x, b.y);
      for (const b of this.bodies) this.advance(b);
      this.t += DT;
    }
  }

  /** Record the final sample; call once at the end. */
  close() {
    for (const b of this.bodies) b.track.push(b.x, b.y);
  }

  advance(b) {
    const t = this.t;
    let leg = null;
    for (const l of b.legs) if (l.at <= t + 1e-9) leg = l;
    if (!leg) return;
    if (leg.kind === 'path') {
      const [x, y, vx, vy] = samplePlan(leg.plan, t + DT - leg.at);
      Object.assign(b, { x, y, vx, vy });
      return;
    }
    const [dvx, dvy] = desired(b, leg, this.byId);
    steer(b, dvx, dvy, DT, leg.effort ?? 1);
    if (leg.kind === 'rush') engage(b, leg, this.byId);
  }
}

function desired(b, leg, byId) {
  const tg = leg.target != null ? byId.get(leg.target) : null;
  switch (leg.kind) {
    case 'go': return goToward(b, leg.x, leg.y, leg.effort ?? 1);
    case 'chase': return tg ? chase(b, tg.x, tg.y, tg.vx, tg.vy, leg) : [0, 0];
    case 'stick': return tg ? goToward(b, tg.x + leg.dx, tg.y + leg.dy, 1) : [0, 0];
    case 'block': {
      const guard = byId.get(leg.guard);
      if (!tg || !guard) return [0, 0];
      const gx = tg.x - guard.x;
      const gy = tg.y - guard.y;
      const d = hyp(gx, gy) || 1;
      const dist = Math.min(leg.dist ?? 1.1, d * 0.7);
      return goToward(b, tg.x - (gx / d) * dist, tg.y - (gy / d) * dist, 1);
    }
    case 'rush': return tg ? chase(b, tg.x, tg.y, tg.vx, tg.vy, { lead: 0.3, effort: leg.effort ?? 1 }) : [0, 0];
    case 'mirror': {
      if (!tg) return [0, 0];
      // where the receiver was `lag` seconds ago, plus the leverage offset (cushion)
      const back = Math.round((leg.lag ?? 0.32) / DT) * 2;
      const n = tg.track.length;
      const px = n > back ? tg.track[n - back - 2] : tg.x;
      const py = n > back ? tg.track[n - back - 1] : tg.y;
      return goToward(b, px + (leg.dx ?? 0), py + (leg.dy ?? 0), 1);
    }
    default: return [0, 0];
  }
}

/** A rusher that runs into one of his blockers is held up there. */
function engage(b, leg, byId) {
  for (const id of leg.blockers || []) {
    const o = byId.get(id);
    if (!o) continue;
    const dx = b.x - o.x;
    const dy = b.y - o.y;
    const d = hyp(dx, dy);
    if (d < 1.0) {
      // pushed back out to arm's length, keeping only a slow push forward
      b.x = o.x + (dx / (d || 1)) * 1.0;
      b.y = o.y + (dy / (d || 1)) * 1.0;
      const sp = hyp(b.vx, b.vy);
      if (sp > 1.1) { b.vx *= 1.1 / sp; b.vy *= 1.1 / sp; }
    }
  }
}

/** Position of body track at time t (linear interpolation between ticks). */
export function trackAt(b, t, dt = DT) {
  const n = b.track.length / 2;
  const f = clip(t / dt, 0, n - 1);
  const i = Math.floor(f);
  const j = Math.min(n - 1, i + 1);
  const w = f - i;
  return [b.track[2 * i] + (b.track[2 * j] - b.track[2 * i]) * w, b.track[2 * i + 1] + (b.track[2 * j + 1] - b.track[2 * i + 1]) * w];
}
