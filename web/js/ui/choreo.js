// Choreography: the engine has already decided what happened on a play (yards, air yards,
// target, flags, kick results). This module stages it — planned paths for the players whose
// motion decides the outcome (passer, target, ball carrier, tackler, kicker, returner) and
// steering for everyone else — then simulates the world and returns tracks, ball segments
// and call-outs for playback.

import { FIELD_W } from './formation.js';
import { DT, World, makeBody, plan, trackAt } from './motion.js';

const MID = FIELD_W / 2;
const clampX = (x) => Math.max(0.7, Math.min(FIELD_W - 0.7, x));
const hyp = Math.hypot;

// lateral offset of the point of attack by run call (yards from the ball)
const HOLE = [
  ['run_out', 9.5], ['run_tackle', 4.2], ['run_guard', 2.0], ['run_middle', 0], ['qb_sneak', 0],
  ['qb_run', 3.5], ['rpo_run', 2.6], ['direct_snap', 3], ['end_around', 13],
];
// typical time to throw by call or depth when the play was not charted
const RELEASE = {
  short: 2.2, deep: 2.8, screen: 1.5, hail: 4.0, pa_short: 3.0, pa_deep: 3.0, rollout: 3.0,
  rpo_pass: 1.35, flea_flicker: 3.6, receiver_pass: 3.2,
};
const DEFAULT_AIR = { short: 6, deep: 24, screen: -2, hail: 46 };
// Cover 3 landmarks in the offense's frame: [u from its left sideline, depth]
const COVER3_DEEP = [[9, 16], [MID, 18], [44.3, 16]];
const COVER3_UNDER = [[6, 6], [18.7, 9], [34.7, 9], [47.3, 6], [MID, 11]];

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param anim   animation facts of the play (session entry .anim)
 * @param scene  the pre-snap scene the play starts from (scene.js)
 * @param after  session view after the play (for turnover and return spots)
 * @param seed   any integer; the same play always looks the same
 * @returns { duration, tracks: Map key -> Float32Array [x, L, ...] per DT, ball, callouts, end }
 */
export function choreograph({ anim, scene, after, seed = 1 }) {
  const c = new Stage(anim, scene, after, seed);
  switch (anim.type) {
    case 'spike':
    case 'kneel': c.clockPlay(); break;
    case 'penalty': c.flag(); break;
    case 'pass': c.pass(); break;
    case 'fg':
    case 'xp': c.fieldGoal(); break;
    case 'punt': c.punt(); break;
    case 'kickoff': c.kickoff(); break;
    case 'two': c.twoPoint(); break;
    default: c.run();
  }
  return c.finish();
}

class Stage {
  constructor(anim, scene, after, seed) {
    this.a = anim;
    this.flags = anim.flags || {};
    this.scene = scene;
    this.after = after;
    this.r = mulberry32(seed >>> 0);
    this.up = scene.up;
    this.fwd = scene.up ? 1 : -1;
    this.los = scene.los;
    this.bx = scene.ballX;
    this.bodies = scene.dots.map((d) => {
      const b = makeBody(d.key, d.group, d.x, d.L, { spd: d.p?.spd, jitter: (this.r() - 0.5) * 0.07 });
      b.dot = d;
      b.off = d.team === scene.offense;
      return b;
    });
    this.world = new World(this.bodies);
    this.off = this.bodies.filter((b) => b.off);
    this.def = this.bodies.filter((b) => !b.off);
    this.ball = [];
    this.callouts = [];
    this.planned = new Set();
    this.end = null;
    this.whistle = 0;
  }

  // --- helpers ---------------------------------------------------------------------------------

  group(list, ...groups) {
    return list.filter((b) => groups.includes(b.group));
  }

  /** The body of a player the engine named (by player id), if he is on the field. */
  named(role, list) {
    const id = this.a.players?.[role];
    return id ? list.find((b) => b.dot.p?.id === id) || null : null;
  }

  /** Screen-x sign for an offense-frame side: +1 = the offense's right. */
  screen(side) {
    return side * this.fwd;
  }

  /** Offense-frame side of a call direction or pass location. */
  side(dirOrLoc) {
    if (dirOrLoc === 'left' || dirOrLoc === 0) return -1;
    if (dirOrLoc === 'right' || dirOrLoc === 2) return 1;
    if (dirOrLoc === 'middle' || dirOrLoc === 1) return 0;
    return this.r() < 0.5 ? -1 : 1;
  }

  get goal() { return this.up ? 100 : 0; }

  get ownGoal() { return this.up ? 0 : 100; }

  /** Where the play's ball carrier ends up (L), from the yards gained. */
  endL() {
    const f = this.flags;
    if (f.td) return this.goal + this.fwd * 1.5;
    if (f.safety) return this.ownGoal - this.fwd * 0.8;
    return Math.max(-9, Math.min(109, this.los + this.fwd * (this.a.yards ?? 0)));
  }

  /** The spot where the other team takes over after a turnover (L), else null. */
  turnoverL() {
    const af = this.after;
    if (!af) return null;
    if (af.phase === 'pat' || af.done) return this.ownGoal - this.fwd * 1.5;
    return af.los ?? null;
  }

  pin(b) {
    this.planned.add(b);
    return b;
  }

  path(b, at, waypoints, opts = {}) {
    const p = plan(b, [[b.x, b.y], ...waypoints], opts);
    this.world.leg(b, { at, kind: 'path', plan: p });
    return p;
  }

  /** Plan from wherever the body is now in the simulation (dropping any later legs). */
  pathFromNow(b, waypoints, opts = {}) {
    b.legs = b.legs.filter((l) => l.at <= this.world.t);
    const v0 = hyp(b.vx, b.vy);
    const p = plan(b, [[b.x, b.y], ...waypoints], { v0, ...opts });
    this.world.leg(b, { at: this.world.t, kind: 'path', plan: p });
    return p;
  }

  leg(b, leg) {
    this.world.leg(b, leg);
  }

  hold(t0, key) { this.ball.push({ t0, kind: 'hold', key }); }

  fly(t0, t1, from, to, h = 1) { this.ball.push({ t0, t1, kind: 'fly', from, to, h }); }

  rest(t0, at) { this.ball.push({ t0, kind: 'rest', at }); }

  say(t, text, tone = 'info') { this.callouts.push({ t, text, tone }); }

  /** Pick the defender (or attacker, for returns) who can reach a point soonest. */
  closest(list, x, y) {
    let best = null;
    let bestT = Infinity;
    for (const b of list) {
      const t = hyp(b.x - x, b.y - y) / b.top + this.r() * 0.15;
      if (t < bestT) { bestT = t; best = b; }
    }
    return best;
  }

  /** Snap: the ball goes from the spot to the QB (or holder/punter). */
  snap(to, arrive = 0.25) {
    this.fly(0, arrive, [this.bx, this.los], to, 0.2);
    this.hold(arrive, to);
  }

  /** Everyone not on a planned path chases the ball carrier; blockers screen for him. */
  pursuit(carrier, at, { carrierSide = carrier.off } = {}) {
    const chasers = carrierSide ? this.def : this.off;
    const mates = carrierSide ? this.off : this.def;
    for (const b of chasers) {
      if (this.planned.has(b)) continue;
      this.leg(b, { at: at + 0.15 + this.r() * 0.2, kind: 'chase', target: carrier.id, lead: 1.1, gap: 0.6 + this.r(), effort: 0.92 });
    }
    for (const b of mates) {
      if (this.planned.has(b) || b === carrier) continue;
      const near = this.closest(chasers, b.x, b.y);
      if (near && hyp(near.x - b.x, near.y - b.y) < 12) this.leg(b, { at: at + 0.2, kind: 'block', target: near.id, guard: carrier.id, dist: 1.0, effort: 0.85 });
      else this.leg(b, { at: at + 0.2, kind: 'chase', target: carrier.id, lead: 0.4, gap: 6, effort: 0.6 });
    }
  }

  /** The carrier is brought down at (x, L) at time tEnd by the best-placed defender. */
  tackle(carrier, x, L, tEnd, { list = this.def } = {}) {
    const into = carrier.off ? this.fwd : -this.fwd;
    const contact = [x, L + into * 0.8];
    // the defender the narration credits makes the tackle when he can get there
    const free = list.filter((b) => !this.planned.has(b));
    const credited = carrier.off ? this.named('defender', free) : null;
    const nearest = this.closest(free, contact[0], contact[1]);
    const reach = (b) => hyp(b.x - contact[0], b.y - contact[1]) / b.top;
    const tackler = credited && reach(credited) <= Math.max(reach(nearest) + 1, tEnd - this.world.t) ? credited : nearest;
    if (!tackler) return null;
    this.pin(tackler);
    const startAt = this.world.t;
    const p = this.pathFromNow(tackler, [contact], { arrive: Math.max(0.2, tEnd - startAt) });
    this.leg(tackler, { at: startAt + p.duration, kind: 'stick', target: carrier.id, dx: 0, dy: into * 0.7 });
    const helper = this.closest(list.filter((b) => !this.planned.has(b)), contact[0], contact[1]);
    if (helper) this.leg(helper, { at: Math.max(startAt, tEnd - 1.2), kind: 'chase', target: carrier.id, lead: 0.6, effort: 1 });
    return { tackler, late: startAt + p.duration > tEnd + 0.15, arrive: startAt + p.duration };
  }

  /** Run a carrier from where he is now to the end spot; returns the whistle time. */
  carry(carrier, endX, endL, { wiggle = true, tackle = !this.flags.td, list } = {}) {
    const start = [carrier.x, carrier.y];
    const pts = [];
    const dist = Math.abs(endL - start[1]);
    if (wiggle && dist > 7) {
      // a cut through daylight at the midpoint
      const cuts = [-3, -1.5, 0, 1.5, 3];
      const w = cuts[Math.floor(this.r() * cuts.length)];
      pts.push([clampX((start[0] + endX) / 2 + w), (start[1] + endL) / 2]);
    }
    pts.push([endX, endL]);
    let p = this.pathFromNow(carrier, pts, { maxEffort: 0.97 });
    let tEnd = this.world.t + p.duration;
    if (tackle) {
      const t = this.tackle(carrier, endX, endL, tEnd, { list });
      if (t?.late) {
        // nobody gets there in time at full speed: the carrier is caught a bit later
        carrier.legs = carrier.legs.filter((l) => l.plan !== p);
        p = this.pathFromNow(carrier, pts, { maxEffort: 0.97, arrive: t.arrive - this.world.t });
        tEnd = this.world.t + p.duration;
      }
    }
    return tEnd;
  }

  /** Call-outs once the carrier is down at endL. */
  result(tEnd) {
    const f = this.flags;
    const y = Math.round(this.a.yards ?? 0);
    if (f.td) this.say(tEnd - 0.2, 'Touchdown!', 'boom');
    else if (f.safety) this.say(tEnd, 'Safety!', 'hit');
    else if (f.oob) this.say(tEnd, 'Out of bounds');
    else if (y < 0) this.say(tEnd, `Stopped for a loss of ${-y}`, 'hit');
    else this.say(tEnd, y === 0 ? 'No gain' : 'Tackled');
    if (f.first && !f.td) this.say(tEnd + 0.35, 'First down', 'good');
    if (f.downs) this.say(tEnd + 0.35, 'Turnover on downs', 'hit');
    if (f.penalty) this.say(tEnd + 0.2, 'Flag on the play', 'flag');
  }

  // --- line play --------------------------------------------------------------------------------

  /** Offensive line and tight ends block; the defensive front rushes `target`. */
  lineBattle(target, { pass }) {
    const ol = this.group(this.off, 'OL').filter((b) => !this.planned.has(b));
    const front = this.group(this.def, 'DL').filter((b) => !this.planned.has(b));
    const blockers = ol.map((b) => b.id);
    for (const b of ol) {
      const man = this.closest(front, b.x, b.y) || front[0];
      if (man) this.leg(b, { at: 0.18, kind: 'block', target: man.id, guard: target.id, dist: pass ? 1.0 : 0.8, effort: 0.8 });
      else this.leg(b, { at: 0.18, kind: 'go', x: b.x, y: b.y - this.fwd * (pass ? 2.5 : -1), effort: 0.5 });
    }
    for (const b of front) this.leg(b, { at: 0.3, kind: 'rush', target: target.id, blockers, effort: pass ? 0.9 : 0.8 });
    return blockers;
  }

  // --- plays ------------------------------------------------------------------------------------

  clockPlay() {
    const qb = this.group(this.off, 'QB')[0] || this.off[0];
    this.pin(qb);
    this.snap(qb.id, 0.15);
    if (this.a.type === 'spike') {
      this.path(qb, 0.15, [[qb.x, qb.y - this.fwd * 0.4]], { maxEffort: 0.3 });
      this.fly(0.65, 0.8, qb.id, [qb.x + 0.3, this.los + this.fwd * 1.2], 0.3);
      this.rest(0.8, [qb.x + 0.3, this.los + this.fwd * 1.2]);
      this.say(0.8, 'Spike');
    } else {
      this.path(qb, 0.15, [[qb.x, qb.y - this.fwd * 1.0]], { maxEffort: 0.3 });
      this.say(0.9, 'Kneel');
    }
    for (const b of this.bodies) if (b !== qb) this.leg(b, { at: 0.3, kind: 'go', x: b.x, y: b.y + (b.off ? -1 : 1) * this.fwd * 0.4, effort: 0.3 });
    this.whistle = 1.3;
  }

  /** A play wiped out by a flag: a couple of steps, then the whistle. */
  flag() {
    const qb = this.group(this.off, 'QB')[0] || this.off[0];
    this.pin(qb);
    this.snap(qb.id, 0.25);
    this.path(qb, 0.25, [[qb.x, qb.y - this.fwd * 1.5]], { maxEffort: 0.4 });
    for (const b of this.bodies) {
      if (b === qb) continue;
      const step = (b.off ? 1 : -1) * this.fwd * (b.group === 'OL' || b.group === 'DL' ? 0.6 : 2);
      this.leg(b, { at: 0.2, kind: 'go', x: b.x, y: b.y + step, effort: 0.5 });
    }
    this.say(1.0, 'Flag on the play', 'flag');
    this.whistle = 1.5;
  }

  run() {
    const a = this.a;
    const f = this.flags;
    const qb = this.group(this.off, 'QB')[0] || this.off[0];
    const backs = this.group(this.off, 'RB');
    let carrier = this.named('carrier', this.off);
    if (!carrier) {
      if (a.call === 'end_around') carrier = this.group(this.off, 'WR')[0];
      else if (f.scramble || a.call === 'qb_sneak' || a.call === 'qb_run' || a.tgt === 0 || !backs.length) carrier = qb;
      else carrier = backs[0];
    }
    carrier ||= qb;
    this.pin(carrier);
    const side = this.side(a.dir);
    const holeU = (HOLE.find(([k]) => a.call?.startsWith(k)) || [null, 2])[1];
    const holeX = clampX(this.bx + this.screen(side || (this.r() < 0.5 ? -1 : 1)) * (side ? holeU : this.r() * 1.2));
    const endL = this.endL();
    const gain = (endL - this.los) * this.fwd;
    let endX;
    if (f.oob) {
      const s = side ? this.screen(side) : Math.sign(holeX - MID) || 1;
      endX = s > 0 ? FIELD_W + 0.4 : -0.4;
    } else {
      endX = clampX(holeX + (this.r() - 0.5) * Math.min(9, Math.abs(gain) * 0.4));
    }

    this.snap(qb.id, 0.25);
    const fwd = this.fwd;
    const route = [];
    let mesh = null;
    if (carrier === qb) {
      if (a.call === 'qb_sneak') route.push([this.bx, this.los + fwd * 0.2]);
      else route.push([this.bx + (holeX - this.bx) * 0.3, this.los - fwd * 2.2], [holeX, this.los - fwd * 0.3]);
    } else {
      const depth = Math.max(2.8, Math.min(4.6, Math.abs(qb.y - this.los)));
      mesh = [this.bx + Math.sign(holeX - this.bx || 1) * 0.8, this.los - fwd * depth];
      route.push(mesh, [holeX, this.los - fwd * 0.4]);
    }
    // stopped in the backfield: he never reaches the hole
    if (gain < 0.5 && route.length > 1) route.pop();
    this.world.run(0.2);
    const toHole = this.pathFromNow(carrier, route, { maxEffort: 0.95, vEnd: 6 });
    const tHole = this.world.t + toHole.duration;
    let tHandoff = 0.25;
    if (mesh) {
      // the handoff happens where the back passes the mesh point
      let k = 0;
      for (let i = 0; i < toHole.xs.length; i += 1) {
        if (hyp(toHole.xs[i] - mesh[0], toHole.ys[i] - mesh[1]) < hyp(toHole.xs[k] - mesh[0], toHole.ys[k] - mesh[1])) k = i;
      }
      tHandoff = Math.max(0.45, this.world.t + toHole.t[k]);
      this.pin(qb);
      this.path(qb, 0.25, [[mesh[0] - Math.sign(holeX - this.bx || 1) * 0.9, mesh[1] + fwd * 0.2], [this.bx - (holeX - this.bx) * 0.4, this.los - fwd * 6]], { maxEffort: 0.6 });
      this.fly(tHandoff - 0.12, tHandoff, qb.id, carrier.id, 0.1);
      this.hold(tHandoff, carrier.id);
    }
    // lead blockers and receivers
    for (const b of this.group(this.off, 'RB', 'TE')) {
      if (this.planned.has(b)) continue;
      this.leg(b, { at: 0.18, kind: 'go', x: holeX + (this.r() - 0.5) * 2, y: this.los + fwd * 0.5, effort: 0.85 });
    }
    for (const b of this.group(this.off, 'WR')) {
      if (this.planned.has(b)) continue;
      const db = this.closest(this.group(this.def, 'CB', 'S'), b.x, b.y);
      if (db) this.leg(b, { at: 0.3, kind: 'block', target: db.id, guard: carrier.id, dist: 1.1, effort: 0.8 });
    }
    this.lineBattle(carrier, { pass: false });
    for (const b of this.group(this.def, 'LB')) {
      if (this.planned.has(b)) continue;
      this.leg(b, { at: 0.3, kind: 'go', x: holeX + (this.r() - 0.5) * 3, y: this.los + fwd * 1.5, effort: 0.9 });
      this.leg(b, { at: 0.9 + this.r() * 0.3, kind: 'chase', target: carrier.id, lead: 1, effort: 0.95 });
    }
    for (const b of this.group(this.def, 'CB', 'S')) {
      if (this.planned.has(b)) continue;
      this.leg(b, { at: 0.3, kind: 'go', x: b.x, y: b.y + fwd * 1.2, effort: 0.5 });
      this.leg(b, { at: 1.0 + this.r() * 0.3, kind: 'chase', target: carrier.id, lead: 1.2, gap: 0.5, effort: 0.95 });
    }
    this.world.run(Math.max(tHole - 0.05, this.world.t));
    const tEnd = this.carry(carrier, endX, endL, { wiggle: gain > 7 });
    if (f.fumble) {
      this.say(tEnd - 0.1, 'Fumble!', 'hit');
      const loose = [clampX(endX + (this.r() - 0.5) * 3), endL + fwd * (this.r() * 2 - 0.5)];
      this.ballLoose(carrier, tEnd, loose);
    } else {
      this.result(tEnd);
    }
    this.whistle = tEnd;
    this.end = [endX, f.td ? this.goal : endL];
  }

  /** Ball pops loose at the end of a run or catch; the nearest defender falls on it. */
  ballLoose(carrier, t, at) {
    this.fly(t - 0.05, t + 0.45, carrier.id, at, 0.6);
    this.rest(t + 0.45, at);
    this.world.run(t);
    const rec = this.closest(this.def.filter((b) => !this.planned.has(b)), at[0], at[1]) || this.def[0];
    this.pin(rec);
    this.pathFromNow(rec, [at], { arrive: 0.6 });
    this.hold(t + 0.75, rec.id);
    this.say(t + 0.8, 'Recovered by the defense', 'hit');
  }

  /** The intended receiver for a pass, from the charted target group and location. */
  target(a) {
    const named = this.named('target', this.off);
    if (named && named.group !== 'QB') return named;
    const groupOf = { 1: 'RB', 2: 'WR', 3: 'TE' }[a.tgt];
    const pool = this.off.filter((b) => ['WR', 'TE', 'RB'].includes(b.group));
    let list = groupOf ? pool.filter((b) => b.group === groupOf) : pool;
    if (a.depth === 'screen' && !groupOf) list = pool.filter((b) => b.group === 'RB');
    if (!list.length) list = pool.length ? pool : this.off;
    const side = this.side(a.loc ?? a.dir);
    const u = (b) => (b.x - this.bx) * this.fwd;   // offense-frame lateral offset
    if (side === 0) return list.reduce((m, b) => (Math.abs(u(b)) < Math.abs(u(m)) ? b : m));
    const ranked = [...list].sort((p, q) => side * (u(q) - u(p)));
    // deep shots go to the widest man on that side, short throws to the inside one
    if (a.depth === 'deep' || a.depth === 'hail') return ranked[0];
    const sameSide = ranked.filter((b) => Math.sign(u(b)) === side);
    return sameSide.length ? sameSide[sameSide.length - 1] : ranked[0];
  }

  pass() {
    const a = this.a;
    const f = this.flags;
    const fwd = this.fwd;
    const qb = this.group(this.off, 'QB')[0] || this.off[0];
    this.pin(qb);
    this.snap(qb.id, Math.abs(qb.y - this.los) > 3 ? 0.3 : 0.15);
    const depth = a.depth || (a.call?.startsWith('deep') ? 'deep' : 'short');
    const side = this.side(a.loc ?? a.dir);

    // the quarterback's drop
    const backs = this.group(this.off, 'RB');
    let drop;
    if (a.call === 'rollout') {
      const s = this.screen(side || 1);
      drop = [[this.bx + s * 3.5, this.los - fwd * 6.6], [clampX(this.bx + s * 9.5), this.los - fwd * 6.3]];
    } else if (a.call?.startsWith('pa_') || a.call === 'flea_flicker') {
      const rb = backs[0];
      const fake = rb ? [rb.x * 0.5 + this.bx * 0.5, this.los - fwd * 4.2] : [this.bx, this.los - fwd * 4];
      drop = [fake, [this.bx + (this.r() - 0.5), this.los - fwd * 7.8]];
    } else {
      const deep = { deep: 7.8, hail: 8.6, screen: 7.6 }[depth] ?? 7.2;
      drop = [[this.bx + (this.r() - 0.5) * 0.8, this.los - fwd * deep]];
    }
    if (f.sack) { this.sack(qb, drop); return; }
    if (f.scramble) { this.scramble(qb, drop); return; }

    const target = this.pin(this.target(a));
    let air = a.air ?? DEFAULT_AIR[depth] ?? 7;
    if (!f.inc && !f.int && a.yards != null && !f.td) air = Math.min(air, a.yards);
    if (f.td) air = Math.min(air, (this.goal - this.los) * fwd + 6);
    const catchL = this.los + fwd * air;
    const toMid = Math.sign(MID - target.x) || 1;
    let catchX;
    if (depth === 'screen' || air < 1) catchX = target.x + toMid * 1.5;
    else if (side === 0) catchX = target.x + toMid * Math.min(Math.abs(MID - target.x) * 0.6, 9);
    else if (air < 10) catchX = target.x - toMid * (2 + this.r() * 2.5);
    else catchX = target.x - toMid * this.r() * 2;
    catchX = Math.max(2, Math.min(FIELD_W - 2, catchX));

    const route = [];
    if (air < 1.5) route.push([target.x + toMid * 1.2, this.los - fwd * 1.5]);
    else if (air >= 12) route.push([target.x, this.los + fwd * Math.min(air * 0.45, 11)]);
    else route.push([target.x, catchL + fwd * 0.4]);
    route.push([catchX, catchL]);

    const qbPlan = this.path(qb, 0.3, drop, { maxEffort: 0.78 });
    const qbSet = 0.3 + qbPlan.duration;
    const release = RELEASE[a.call] ?? RELEASE[depth] ?? 2.4;
    const routePlan0 = plan(target, [[target.x, target.y], ...route]);
    const qbAt = drop[drop.length - 1];
    const dist = hyp(catchX - qbAt[0], catchL - qbAt[1]);
    const flight = dist / (24 - 0.09 * Math.min(60, dist));
    // the throw is timed so ball and receiver meet: he runs the route to arrive on time
    const wanted = Math.max(0.18 + routePlan0.duration, Math.max(release + (this.r() - 0.5) * 0.4, qbSet) + flight);
    const tCatch = 0.18 + this.path(target, 0.18, route, { arrive: wanted - 0.18 }).duration;
    const tRel = tCatch - flight;

    this.passProtection(qb);
    this.coverage(target, tRel);
    this.fly(tRel, tCatch, qb.id, [catchX, catchL], Math.min(9, 0.8 + dist / 7));

    if (f.int) { this.interception(target, [catchX, catchL], tCatch); return; }
    if (f.inc) { this.incomplete(target, [catchX, catchL], tCatch); return; }

    // caught: run after the catch to the spot
    this.world.run(tCatch);
    this.hold(tCatch, target.id);
    const endL = this.endL();
    const yac = (endL - catchL) * fwd;
    let endX;
    if (f.oob) endX = target.x > MID ? FIELD_W + 0.4 : -0.4;
    else endX = clampX(catchX + (this.r() - 0.5) * Math.min(10, Math.max(1, yac) * 0.5));
    let tEnd;
    if (yac > 0.8 || f.td) {
      if (yac > 4) this.say(tCatch + 0.1, 'Caught');
      tEnd = this.carry(target, endX, endL, { wiggle: yac > 7 });
    } else {
      tEnd = this.carry(target, clampX(catchX + 0.3), Math.min(Math.max(endL, catchL - 1), catchL + 1), { wiggle: false });
    }
    this.pursuit(target, tCatch);
    if (f.fumble) { this.say(tEnd - 0.1, 'Fumble!', 'hit'); this.ballLoose(target, tEnd, [endX, endL]); }
    else this.result(tEnd);
    this.whistle = tEnd;
    this.end = [endX, f.td ? this.goal : endL];
  }

  passProtection(qb) {
    const blitz = this.scene.look === 'blitz';
    const blitzers = this.group(this.def, 'LB', 'S', 'CB').filter((b) => Math.abs(b.y - this.los) < 2.8);
    const blockers = this.lineBattle(qb, { pass: true });
    for (const b of blitzers) this.leg(b, { at: 0.3, kind: 'rush', target: qb.id, blockers, effort: 0.95 });
    for (const b of this.group(this.off, 'RB', 'TE')) {
      if (this.planned.has(b)) continue;
      const stay = blitz || (b.group === 'TE' && this.r() < 0.3);
      const threat = this.closest(blitzers.length ? blitzers : this.group(this.def, 'DL'), b.x, b.y);
      if (stay && threat) this.leg(b, { at: 0.2, kind: 'block', target: threat.id, guard: qb.id, dist: 1.0, effort: 0.85 });
      else this.leg(b, { at: 0.5, kind: 'go', x: clampX(b.x + (b.x < this.bx ? -7 : 7)), y: this.los + this.fwd * (b.group === 'TE' ? 9 : 2), effort: 0.85 });
    }
    // other receivers run their own routes
    for (const b of this.group(this.off, 'WR')) {
      if (this.planned.has(b)) continue;
      const deep = 8 + this.r() * 9;
      const lean = (MID - b.x) * (this.r() < 0.5 ? 0.15 : -0.05);
      this.leg(b, { at: 0.18, kind: 'go', x: clampX(b.x + lean), y: this.los + this.fwd * deep, effort: 0.9 });
    }
  }

  coverage(target, tRel) {
    const fwd = this.fwd;
    const look = this.scene.look;
    const manOdds = look === 'blitz' ? 0.75 : look === 'soft' ? 0.25 : 0.5;
    const man = this.r() < manOdds;
    const receivers = this.off.filter((b) => ['WR', 'TE', 'RB'].includes(b.group));
    const free = this.def.filter((b) => !this.planned.has(b) && b.group !== 'DL' && Math.abs(b.y - this.los) >= 2.8);
    const toField = ([u, d]) => [this.up ? u : FIELD_W - u, this.los + fwd * d];
    const spots = { deep: COVER3_DEEP.map(toField), under: COVER3_UNDER.map(toField) };
    const taken = new Set();
    for (const b of free) {
      const nearest = receivers.filter((r) => !taken.has(r)).reduce((m, r) => (!m || hyp(r.x - b.x, r.y - b.y) < hyp(m.x - b.x, m.y - b.y) ? r : m), null);
      if (man && nearest && b.group !== 'S' && hyp(nearest.x - b.x, nearest.y - b.y) < 9) {
        taken.add(nearest);
        this.leg(b, { at: 0.3, kind: 'mirror', target: nearest.id, dx: Math.sign(MID - nearest.x) * 0.6, dy: fwd * (nearest.group === 'WR' ? 1.4 : 0.9), lag: 0.28 + this.r() * 0.12 });
      } else {
        const list = b.group === 'S' || (b.group === 'CB' && Math.abs(b.x - MID) > 14) ? spots.deep : spots.under;
        if (!list.length) continue;
        const k = list.reduce((m, p, i) => (hyp(p[0] - b.x, p[1] - b.y) < hyp(list[m][0] - b.x, list[m][1] - b.y) ? i : m), 0);
        const [x, y] = list.splice(k, 1)[0];
        this.leg(b, { at: 0.3, kind: 'go', x, y, effort: 0.8 });
      }
    }
    // everyone breaks on the ball once it is in the air
    for (const b of free) this.leg(b, { at: tRel + 0.25 + this.r() * 0.2, kind: 'chase', target: target.id, lead: 1.3, effort: 1 });
  }

  incomplete(target, at, tCatch) {
    const fwd = this.fwd;
    const db = this.named('defender', this.def.filter((b) => !this.planned.has(b)))
      || this.closest(this.def.filter((b) => !this.planned.has(b) && b.group !== 'DL'), at[0], at[1]);
    let near = false;
    if (db) {
      this.pin(db);
      const gap = this.r() < 0.55 ? 0.8 : 2.4;
      near = gap < 2;
      this.path(db, 0.3, [[at[0] + Math.sign(MID - at[0]) * 0.5, at[1] + fwd * gap]], { arrive: tCatch - 0.3 });
    }
    const air = Math.abs(at[1] - this.los);
    const miss = near ? [at[0] + (this.r() - 0.5) * 2, at[1] + fwd * 1.5] : [at[0] + (this.r() - 0.5) * 3, at[1] + fwd * (air > 15 ? 4 : 2)];
    const last = this.ball[this.ball.length - 1];
    last.to = miss;
    last.t1 = tCatch + 0.12;
    this.fly(tCatch + 0.12, tCatch + 0.5, miss, [miss[0] + (this.r() - 0.5) * 2, miss[1] + fwd * 1.2], 0.3);
    this.rest(tCatch + 0.5, [miss[0], miss[1] + fwd * 1.2]);
    this.world.run(tCatch);
    this.leg(target, { at: tCatch, kind: 'go', x: target.x, y: target.y + fwd * 2, effort: 0.5 });
    const text = this.flags.drop ? 'Dropped!' : near ? 'Broken up' : air >= 15 ? 'Overthrown' : 'Incomplete';
    this.say(tCatch + 0.1, text, near ? 'hit' : 'info');
    this.whistle = tCatch + 0.7;
    this.end = [this.bx, this.los];
  }

  interception(target, at, tCatch) {
    const fwd = this.fwd;
    const pick = this.named('defender', this.def)
      || this.closest(this.def.filter((b) => !this.planned.has(b) && b.group !== 'DL'), at[0], at[1]) || this.def[0];
    this.pin(pick);
    const spot = [at[0] + Math.sign(MID - at[0]) * 0.4, at[1] - fwd * 1.0];
    this.path(pick, 0.3, [spot], { arrive: tCatch - 0.35 });
    const last = this.ball[this.ball.length - 1];
    last.to = spot;
    this.world.run(tCatch);
    this.hold(tCatch, pick.id);
    this.say(tCatch + 0.05, 'Intercepted!', 'hit');
    const retL = this.turnoverL() ?? spot[1];
    const endX = clampX(spot[0] + (this.r() - 0.5) * 8);
    const tEnd = this.carry(pick, endX, retL, { tackle: this.after?.phase !== 'pat', list: this.off });
    this.pursuit(pick, tCatch, { carrierSide: false });
    if (this.after?.phase === 'pat') this.say(tEnd - 0.2, 'Pick-six!', 'hit');
    this.whistle = tEnd;
    this.end = [endX, retL];
  }

  sack(qb, drop) {
    const fwd = this.fwd;
    const endL = this.endL();
    const end = [clampX(drop[0][0] + (this.r() - 0.5) * 3), endL];
    const p = this.path(qb, 0.3, [drop[0], end], { arrive: 2.1 + this.r() * 0.8 });
    const tSack = 0.3 + p.duration;
    const rusher = this.pin(this.named('defender', this.def) || this.closest(this.group(this.def, 'DL', 'LB'), end[0], end[1]) || this.def[0]);
    this.path(rusher, 0.3, [[rusher.x + (end[0] - rusher.x) * 0.4, this.los + fwd * 0.2], [end[0], end[1] + fwd * 0.7]], { arrive: tSack - 0.3 });
    this.leg(rusher, { at: tSack, kind: 'stick', target: qb.id, dx: 0, dy: fwd * 0.6 });
    this.passProtection(qb);
    this.coverage(qb, tSack + 1);
    this.say(tSack, this.flags.fumble ? 'Strip-sack!' : 'Sacked!', 'hit');
    if (this.flags.safety) this.say(tSack + 0.4, 'Safety!', 'hit');
    this.world.run(tSack);
    if (this.flags.fumble) this.ballLoose(qb, tSack, [end[0] + 1, end[1] - fwd]);
    this.whistle = tSack;
    this.end = [end[0], endL];
  }

  scramble(qb, drop) {
    const fwd = this.fwd;
    const p = this.path(qb, 0.3, drop, { maxEffort: 0.75 });
    const tGo = Math.max(2.3 + this.r() * 0.8, 0.3 + p.duration);
    this.passProtection(qb);
    this.coverage(qb, tGo);
    this.say(tGo, 'Scramble!');
    this.world.run(tGo);
    const s = this.r() < 0.5 ? -1 : 1;
    const out = [clampX(qb.x + s * 6), this.los - fwd * 3];
    const endL = this.endL();
    const endX = this.flags.oob ? (out[0] > MID ? FIELD_W + 0.4 : -0.4) : clampX(out[0] + s * 2);
    const pl = this.pathFromNow(qb, [out, [endX, endL]], { maxEffort: 0.95 });
    const tEnd = this.world.t + pl.duration;
    this.tackle(qb, endX, endL, tEnd);
    this.pursuit(qb, tGo);
    this.result(tEnd);
    this.whistle = tEnd;
    this.end = [endX, endL];
  }

  twoPoint() {
    // a try from the 2: the engine tells us only the call and whether it was good
    const good = Boolean(this.a.good);
    const pass = this.a.kind === 'pass';  // the call's kind
    Object.assign(this.a, {
      yards: good ? 2 : pass ? 0 : 1, air: good ? 3 : 4, loc: 1,
      flags: good ? { td: true } : pass ? { inc: true } : {},
    });
    this.flags = this.a.flags;
    if (pass) this.pass(); else this.run();
    if (!good && !pass) this.say(this.whistle + 0.1, 'Stopped short', 'hit');
    if (good) this.say(this.whistle + 0.3, 'Two-point try good', 'good');
  }

  // --- kicks ------------------------------------------------------------------------------------

  fieldGoal() {
    const a = this.a;
    const fwd = this.fwd;
    const holder = this.bodies.find((b) => b.dot.role === 'H');
    const kicker = this.bodies.find((b) => b.dot.role === 'K');
    const spot = [holder.x + 0.2, holder.y + fwd * 0.4];
    this.fly(0.45, 0.85, [this.bx, this.los], spot, 0.15);
    this.rest(0.85, spot);
    this.pin(kicker);
    this.path(kicker, 0.6, [[spot[0] - 0.5, spot[1] - fwd * 0.7]], { arrive: 0.95, vEnd: 4 });
    const line = this.off.filter((b) => b.dot.role === 'line' || b.dot.role === 'LS' || b.dot.role === 'wing').map((b) => b.id);
    for (const b of this.def) this.leg(b, { at: 0.5, kind: 'rush', target: holder.id, blockers: line, effort: 0.8 });
    for (const id of line) {
      const b = this.world.byId.get(id);
      this.leg(b, { at: 0.45, kind: 'go', x: b.x, y: b.y - fwd * 0.6, effort: 0.4 });
    }
    const posts = [MID, this.goal + fwd * 10];
    const wide = a.made ? (this.r() - 0.5) * 1.6 : (this.r() < 0.5 ? -1 : 1) * (4.2 + this.r() * 2);
    const target = [MID + wide, posts[1] + fwd * 1];
    const dist = hyp(target[0] - spot[0], target[1] - spot[1]);
    const tKick = 1.55;
    const tLand = tKick + dist / 24;
    this.fly(tKick, tLand, spot, target, Math.min(14, 5 + dist / 5));
    this.rest(tLand, target);
    this.say(tLand - 0.15, a.made ? (a.type === 'xp' ? 'Extra point good' : "It's good!") : 'No good', a.made ? 'good' : 'hit');
    this.whistle = tLand;
    this.end = [MID, posts[1]];
  }

  punt() {
    const a = this.a;
    const fwd = this.fwd;
    const punter = this.bodies.find((b) => b.dot.role === 'P');
    const returner = this.bodies.find((b) => b.dot.role === 'R');
    this.pin(punter);
    this.snap(punter.id, 0.85);
    const endL = this.after?.los ?? this.los + fwd * (a.net ?? 40);
    const touchback = a.touchback ?? (a.recvYl ?? 0) >= 80;
    const ret = touchback ? 0 : Math.max(0, Math.round(this.r() * 9 - 2));
    const land = touchback ? [MID + (this.r() - 0.5) * 10, this.goal + fwd * 3] : [clampX(this.bx + (this.r() - 0.5) * 14), endL + fwd * ret];
    this.path(punter, 1.0, [[punter.x, punter.y + fwd * 1.5]], { maxEffort: 0.5 });
    const tKick = 2.0;
    const hang = 3.7 + this.r() * 0.8;
    const tLand = tKick + hang;
    this.fly(tKick, tLand, punter.id, land, 18);
    for (const b of this.off) {
      if (this.planned.has(b)) continue;
      const gunner = b.dot.role === 'gunner';
      this.leg(b, { at: gunner ? 0.4 : 1.3, kind: 'go', x: clampX(land[0] + (b.x - this.bx) * 0.4), y: land[1] - fwd * (gunner ? 2 : 6 + this.r() * 6), effort: gunner ? 1 : 0.85 });
    }
    for (const b of this.def) {
      if (b === returner) continue;
      this.leg(b, { at: 1.0, kind: 'go', x: b.x, y: b.y + fwd * (8 + this.r() * 12), effort: 0.7 });
    }
    this.pin(returner);
    this.path(returner, 0.6, [[land[0], land[1] + fwd * 0.3]], { arrive: tLand - 0.9 });
    this.world.run(tLand);
    if (touchback) {
      this.rest(tLand, land);
      this.say(tLand, 'Touchback');
      this.whistle = tLand + 0.4;
      this.end = [MID, this.goal - fwd * 20];
    } else {
      this.hold(tLand, returner.id);
      if (ret < 1) this.say(tLand, 'Fair catch');
      const endX = clampX(land[0] + (this.r() - 0.5) * 4);
      const tEnd = ret < 1 ? tLand + 0.3 : this.carry(returner, endX, endL, { list: this.off });
      if (ret >= 1) this.pursuit(returner, tLand, { carrierSide: false });
      this.say(tEnd + 0.2, `Punt · net ${a.net}`);
      this.whistle = tEnd;
      this.end = [ret < 1 ? land[0] : endX, endL];
    }
  }

  kickoff() {
    const a = this.a;
    const fwd = this.fwd;
    const kicker = this.bodies.find((b) => b.dot.role === 'K');
    const returners = this.bodies.filter((b) => b.dot.role === 'R');
    const tee = [MID, this.los];
    this.rest(0, tee);
    this.pin(kicker);
    this.path(kicker, 0.1, [[tee[0] - 0.4, tee[1] - fwd * 0.6]], { arrive: 0.9, vEnd: 5 });
    const tKick = 1.0;
    if (a.onside) {
      const land = [MID + (this.r() < 0.5 ? -8 : 8), this.los + fwd * 11];
      this.fly(tKick, tKick + 0.9, tee, land, 1.2);
      for (const b of this.bodies) if (b !== kicker) this.leg(b, { at: tKick, kind: 'go', x: land[0] + (this.r() - 0.5) * 6, y: land[1] + (this.r() - 0.5) * 5, effort: 1 });
      this.world.run(tKick + 1.0);
      const team = a.recovered ? this.off : this.def;
      const rec = this.closest(team, land[0], land[1]);
      this.pin(rec);
      this.pathFromNow(rec, [land], { arrive: 0.4 });
      this.hold(tKick + 1.4, rec.id);
      this.say(tKick + 1.5, a.recovered ? 'Onside kick recovered!' : 'Onside kick: they recover', a.recovered ? 'good' : 'hit');
      this.whistle = tKick + 1.8;
      this.end = [land[0], land[1]];
      return;
    }
    const startL = this.after?.los ?? this.los + fwd * 30;
    const farGoal = this.goal;
    const touchback = Math.abs(startL - (farGoal - fwd * 35)) < 0.6 && !a.td;
    const land = touchback ? [MID + (this.r() - 0.5) * 8, farGoal + fwd * (2 + this.r() * 6)] : [MID + (this.r() - 0.5) * 12, farGoal - fwd * (2 + this.r() * 9)];
    const hang = 3.7 + this.r() * 0.6;
    const tLand = tKick + hang;
    this.fly(tKick, tLand, tee, land, 20);
    const ret = returners.reduce((m, b) => (hyp(b.x - land[0], b.y - land[1]) < hyp(m.x - land[0], m.y - land[1]) ? b : m), returners[0]);
    this.pin(ret);
    this.path(ret, 1.2, [[land[0], land[1] - fwd * 0.3]], { arrive: hang - 0.5 });
    // nobody else may move until the ball lands (2024+ kickoff rules)
    this.world.run(tLand);
    this.hold(tLand, ret.id);
    if (touchback) {
      this.say(tLand + 0.2, 'Touchback');
      this.whistle = tLand + 0.8;
      this.end = [MID, startL];
      return;
    }
    const endX = clampX(land[0] + (this.r() - 0.5) * 10);
    const td = Boolean(a.td);
    const endL = td ? this.ownGoal - fwd * 1.5 : startL;
    const tEnd = this.carry(ret, endX, endL, { tackle: !td, list: this.off });
    this.pursuit(ret, tLand, { carrierSide: false });
    this.say(tEnd + 0.1, td ? 'Kick return touchdown!' : 'Kickoff returned', td ? 'boom' : 'info');
    this.whistle = tEnd;
    this.end = [endX, endL];
  }

  // --- output -----------------------------------------------------------------------------------

  finish() {
    const until = this.whistle + 0.9;
    // a beat after the whistle everyone eases up
    for (const b of this.bodies) if (!this.planned.has(b)) this.leg(b, { at: this.whistle + 0.35, kind: 'stand' });
    this.world.run(until);
    this.world.close();
    const byId = this.world.byId;
    const tracks = new Map(this.bodies.map((b) => [b.id, Float32Array.from(b.track)]));
    // resolve ball segments: body references become positions at segment boundaries
    const pos = (ref, t) => (Array.isArray(ref) ? ref : trackAt(byId.get(ref), t));
    const segs = this.ball.sort((p, q) => p.t0 - q.t0).map((s, i, all) => {
      const t1 = s.t1 ?? all[i + 1]?.t0 ?? until;
      if (s.kind === 'fly') return { ...s, t1, from: pos(s.from, s.t0), to: pos(s.to, t1) };
      return { ...s, t1 };
    });
    return { duration: until, dt: DT, tracks, ball: segs, callouts: this.callouts.sort((p, q) => p.t - q.t), end: this.end, whistle: this.whistle };
  }
}
