// The field: an SVG of a vertical football field (the user's end zone at the bottom, the
// opponent's at the top), the 22 players as rating-coloured dots, the ball, line of
// scrimmage and line to gain, a follow camera and playback of choreographed plays.

import { h, s, reducedMotion } from './dom.js';
import { FIELD_W, HASH_L, HASH_R } from './formation.js';
import { mph, shortName } from './format.js';
import { inkOn } from './teams.js';

const U = 7.5;                       // SVG units per yard
const APRON = 2.2;                   // yards of sideline area drawn around the field
const WORLD_W = (FIELD_W + 2 * APRON) * U;
const WORLD_H = (120 + 2 * APRON) * U;
const X = (x) => (x + APRON) * U;
const Y = (L) => (110 + APRON - L) * U;
const DOT_R = 1.15 * U;
const ST_R = 0.78 * U;
const POS_NAMES = {
  QB: 'Quarterback', RB: 'Running back', FB: 'Fullback', WR: 'Wide receiver', TE: 'Tight end', T: 'Tackle', G: 'Guard',
  C: 'Center', DE: 'Defensive end', DT: 'Defensive tackle', NT: 'Nose tackle', OLB: 'Outside linebacker',
  ILB: 'Inside linebacker', MLB: 'Middle linebacker', LB: 'Linebacker', CB: 'Cornerback', DB: 'Defensive back',
  FS: 'Free safety', SS: 'Strong safety', S: 'Safety', K: 'Kicker', P: 'Punter',
};
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Rating 40–99 on a red → amber → green ramp. */
function ratingColor(r) {
  const v = Math.max(0, Math.min(1, (r - 48) / 46));
  const hue = v < 0.5 ? 2 + v * 2 * 40 : 42 + (v - 0.5) * 2 * 100;
  const sat = v < 0.5 ? 80 : 74 - (v - 0.5) * 2 * 14;
  const light = v < 0.5 ? 53 : 52 - (v - 0.5) * 2 * 12;
  return { fill: `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`, ink: hue > 28 && hue < 105 ? '#141821' : '#ffffff' };
}

export class Field {
  /**
   * @param host     element to render into
   * @param teams    [team info 0, team info 1] (teams.js objects) and `me`
   */
  constructor(host, { teams, me }) {
    this.teams = teams;
    this.me = me;
    this.dots = new Map();
    this.cam = 50;
    this.scene = null;
    this.playing = null;
    this.svg = s('svg', { class: 'field', role: 'group', 'aria-label': 'Field' });
    this.world = s('g', { class: 'world' });
    this.marks = s('g', { class: 'marks' });
    this.players = s('g', { class: 'players' });
    this.ballG = s('g', { class: 'ball' },
      s('ellipse', { class: 'ball-shadow', rx: 0.62 * U, ry: 0.36 * U }),
      s('g', { class: 'ball-body' }, s('ellipse', { rx: 0.62 * U, ry: 0.38 * U }), s('path', { d: `M${-0.3 * U} 0H${0.3 * U}`, class: 'lace' })));
    this.world.append(drawTurf(teams, me), this.marks, this.players, this.ballG);
    this.svg.append(this.world);
    this.callouts = h('div', { class: 'callouts', 'aria-hidden': 'true' });
    this.card = h('div', { class: 'pcard', hidden: true, 'aria-live': 'polite' });
    const mouse = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
    this.hint = h('div', { class: 'tap-hint', 'aria-hidden': 'true' }, `${mouse ? 'Click' : 'Tap'} the field to skip`);
    this.el = h('div', { class: 'field-wrap' }, this.svg, this.callouts, legend(), this.hint, this.card);
    host.append(this.el);
    this.el.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.svg.addEventListener('keydown', (e) => this.onKey(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    this.layout();
  }

  // --- camera ---------------------------------------------------------------------------------

  layout() {
    // the screen was replaced: stop watching
    if (!this.el.isConnected) {
      this.ro.disconnect();
      return;
    }
    const w = this.el.clientWidth || 360;
    const hgt = this.el.clientHeight || 480;
    this.viewH = Math.min(WORLD_H, WORLD_W * (hgt / w));
    this.span = this.viewH / U;
    this.setCamera(this.cam);
  }

  setCamera(L) {
    const half = this.span / 2;
    const lo = -10 - APRON + half;
    const hi = 110 + APRON - half;
    this.cam = lo > hi ? 50 : Math.max(lo, Math.min(hi, L));
    const y0 = Y(this.cam) - this.viewH / 2;
    this.svg.setAttribute('viewBox', `0 ${y0.toFixed(2)} ${WORLD_W} ${this.viewH.toFixed(2)}`);
  }

  /** Camera centre that frames a scene: line of scrimmage low, the field ahead in view. */
  presnapCamera(scene) {
    const dir = scene.up ? 1 : -1;
    // kickoffs: the kicker low in the frame, the coverage and the setup zone ahead of him
    if (scene.type === 'kickoff') return scene.los + dir * Math.min(30, this.span / 2 - 6);
    const back = Math.max(9, Math.min(17, this.span * 0.24)) + (scene.type === 'punt' ? 6 : 0);
    return scene.los - dir * back + dir * this.span / 2;
  }

  // --- scenes -----------------------------------------------------------------------------------

  /** Show a pre-snap scene; dots that stay on the field glide to their new spots. */
  show(scene, { animate = true, label = '' } = {}) {
    this.closeCard();
    this.clearCallouts();
    this.el.classList.remove('after-play');
    this.scene = scene;
    this.svg.setAttribute('aria-label', label || 'Field');
    this.drawMarks(scene);
    const keep = new Set();
    const moves = [];
    for (const d of scene.dots) {
      keep.add(d.key);
      let dot = this.dots.get(d.key);
      if (!dot) {
        dot = this.makeDot(d);
        dot.x = d.x;
        dot.L = d.L;
        this.place(dot, d.x, d.L);
        if (animate && !reducedMotion()) dot.g.classList.add('enter');
      } else {
        this.refreshDot(dot, d);
        moves.push({ dot, from: [dot.x, dot.L], to: [d.x, d.L] });
      }
    }
    for (const [key, dot] of this.dots) {
      if (keep.has(key)) continue;
      this.dots.delete(key);
      if (animate && !reducedMotion()) {
        dot.g.classList.add('leave');
        setTimeout(() => dot.g.remove(), 350);
      } else dot.g.remove();
    }
    this.rovingFocus();
    this.placeTags(scene);
    const ballTo = [scene.ballX, scene.los];
    const camTo = this.presnapCamera(scene);
    if (!animate || reducedMotion()) {
      for (const m of moves) this.place(m.dot, ...m.to);
      this.setBall(ballTo, 0);
      this.setCamera(camTo);
      return Promise.resolve();
    }
    const ballFrom = this.ballAt || ballTo;
    const camFrom = this.cam;
    return tween(450, (k) => {
      const e = easeInOut(k);
      for (const m of moves) this.place(m.dot, m.from[0] + (m.to[0] - m.from[0]) * e, m.from[1] + (m.to[1] - m.from[1]) * e);
      this.setBall([ballFrom[0] + (ballTo[0] - ballFrom[0]) * e, ballFrom[1] + (ballTo[1] - ballFrom[1]) * e], 0);
      this.setCamera(camFrom + (camTo - camFrom) * e);
    });
  }

  drawMarks(scene) {
    this.marks.replaceChildren();
    if (scene.los == null) return;
    const line = (L, cls) => s('line', { class: cls, x1: X(0), x2: X(FIELD_W), y1: Y(L), y2: Y(L) });
    if (scene.type !== 'kickoff') this.marks.append(line(scene.los, 'los'));
    if (scene.ltg != null && scene.ltg > 0 && scene.ltg < 100) this.marks.append(line(scene.ltg, 'ltg'));
  }

  makeDot(d) {
    const team = this.teams[d.team];
    const mine = d.team === this.me;
    const st = d.unit === 'st' && !d.p;
    const g = s('g', { class: ['pl', mine ? 'mine' : 'theirs', d.unit === 'def' || (d.unit === 'st' && d.team !== this.scene.offense) ? 'def' : 'off', st && 'st'] });
    const dot = { key: d.key, g, d, x: 0, L: 0 };
    if (st) {
      g.append(s('circle', { r: ST_R, class: 'body', style: { fill: team.color, stroke: mine ? '#ffffff' : team.alt } }));
    } else {
      const rating = d.p?.r ?? 70;
      const { fill, ink } = ratingColor(rating);
      const isDef = g.classList.contains('def');
      g.append(s('circle', { r: DOT_R * 1.45, class: 'hit' }));
      g.append(isDef
        ? s('rect', { class: 'body', x: -DOT_R, y: -DOT_R, width: 2 * DOT_R, height: 2 * DOT_R, rx: DOT_R * 0.42, style: { fill } })
        : s('circle', { class: 'body', r: DOT_R, style: { fill } }));
      g.append(s('text', { class: 'num', 'text-anchor': 'middle', dy: '0.36em', style: { fill: ink } }, d.p?.num ?? d.role ?? ''));
      g.setAttribute('tabindex', '-1');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `${team.name} ${POS_NAMES[d.p?.pos] || d.p?.pos || ''} number ${d.p?.num ?? ''} ${d.p?.name ?? ''}, rated ${rating}`);
      if (mine && d.unit === 'off' && ['QB', 'RB', 'WR', 'TE'].includes(d.group)) {
        g.append(s('text', { class: 'tag', 'text-anchor': 'middle' }, shortName(d.p)));
      }
    }
    this.players.append(g);
    this.dots.set(d.key, dot);
    return dot;
  }

  refreshDot(dot, d) {
    dot.d = d;
    dot.g.classList.remove('leave', 'enter');
  }

  /** Name tags sit behind each player, or in front if that spot is taken, or not at all. */
  placeTags(scene) {
    const placed = [];
    const back = scene.up ? 1 : -1;
    const tagged = [...this.dots.values()].filter((d) => d.g.querySelector('.tag'))
      .sort((a, b) => a.d.x - b.d.x);
    for (const dot of tagged) {
      const tag = dot.g.querySelector('.tag');
      const w = tag.textContent.length * 4.3 + 4;
      const cx = X(dot.d.x);
      let ok = false;
      for (const side of [back, -back]) {
        const dy = side * (DOT_R * 2.25) + 2.5;
        const box = { x0: cx - w / 2, x1: cx + w / 2, y0: Y(dot.d.L) + dy - 7, y1: Y(dot.d.L) + dy + 2 };
        const clash = placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)
          || [...this.dots.values()].some((o) => o !== dot && Math.abs(X(o.d.x) - cx) < w / 2 + DOT_R && Math.abs(Y(o.d.L) - (box.y0 + box.y1) / 2) < DOT_R + 4);
        if (!clash) {
          tag.setAttribute('y', dy);
          placed.push(box);
          ok = true;
          break;
        }
      }
      tag.style.display = ok ? '' : 'none';
    }
  }

  place(dot, x, L) {
    dot.x = x;
    dot.L = L;
    dot.g.setAttribute('transform', `translate(${X(x).toFixed(1)} ${Y(L).toFixed(1)})`);
  }

  setBall([x, L], height) {
    this.ballAt = [x, L];
    const lift = height * U * 0.3;
    const scale = 1 + height / 7;
    this.ballG.setAttribute('transform', `translate(${X(x).toFixed(1)} ${Y(L).toFixed(1)})`);
    this.ballG.firstChild.setAttribute('opacity', height > 0.3 ? 0.35 : 0);
    this.ballG.lastChild.setAttribute('transform', `translate(0 ${(-lift).toFixed(1)}) rotate(${this.ballAngle ?? -90}) scale(${scale.toFixed(2)})`);
  }

  // --- playback ---------------------------------------------------------------------------------

  /**
   * Play a choreography. `onTick(fraction of the way to the whistle)` drives the clock.
   * Resolves at the end; tapping the field (or skip()) jumps to the end.
   */
  play(ch, { onTick = () => {} } = {}) {
    this.closeCard();
    this.clearCallouts();
    this.el.classList.add('is-playing');
    this.camT = 0;
    const fired = new Set();
    const instant = reducedMotion();
    return new Promise((resolve) => {
      const start = performance.now();
      const finish = () => {
        this.renderAt(ch, ch.duration, fired, true);
        onTick(1);
        this.playing = null;
        this.el.classList.remove('is-playing');
        this.el.classList.add('after-play');
        resolve();
      };
      this.playing = { skip: finish };
      if (instant) { finish(); return; }
      const frame = (now) => {
        if (!this.playing) return;
        const t = (now - start) / 1000;
        if (t >= ch.duration) { finish(); return; }
        this.renderAt(ch, t, fired, false);
        onTick(Math.min(1, t / Math.max(0.1, ch.whistle)));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  skip() {
    this.playing?.skip();
  }

  renderAt(ch, t, fired, jump) {
    const f = t / ch.dt;
    for (const [key, tr] of ch.tracks) {
      const dot = this.dots.get(key);
      if (!dot) continue;
      const n = tr.length / 2;
      const i = Math.min(n - 1, Math.floor(f));
      const j = Math.min(n - 1, i + 1);
      const w = Math.min(1, f - i);
      this.place(dot, tr[2 * i] + (tr[2 * j] - tr[2 * i]) * w, tr[2 * i + 1] + (tr[2 * j + 1] - tr[2 * i + 1]) * w);
    }
    const [bx, bL, bh, angle] = ballAt(ch, t);
    this.ballAngle = angle;
    this.setBall([bx, bL], bh);
    // follow the ball, leading a little in the direction of play
    const lead = (this.scene?.up ? 1 : -1) * this.span * 0.08;
    const target = bL + lead;
    // ease toward the target at a fixed rate per second, whatever the frame rate
    const k = 1 - Math.exp(-5 * Math.max(0, t - this.camT));
    this.camT = t;
    this.setCamera(jump ? target : this.cam + (target - this.cam) * k);
    for (const c of ch.callouts) {
      if (c.t > t || fired.has(c)) continue;
      fired.add(c);
      // when skipping, only the last word on the play is worth showing
      if (!jump || c === ch.callouts[ch.callouts.length - 1] || c.t >= ch.whistle - 0.3) this.callout(c.text, c.tone);
    }
  }

  callout(text, tone) {
    const el = h('div', { class: ['callout', `tone-${tone}`] }, text);
    this.callouts.prepend(el);
    while (this.callouts.children.length > 2) this.callouts.lastChild.remove();
    setTimeout(() => el.classList.add('out'), 2300);
    setTimeout(() => el.remove(), 2700);
  }

  clearCallouts() {
    this.callouts.replaceChildren();
  }

  // --- interaction --------------------------------------------------------------------------

  onPointer(e) {
    if (this.playing) {
      e.preventDefault();
      this.skip();
      return;
    }
    if (this.card.contains(e.target)) return;
    const g = e.target.closest?.('.pl');
    const dot = g && [...this.dots.values()].find((d) => d.g === g);
    if (dot?.d.p) this.openCard(dot);
    else this.closeCard();
  }

  onKey(e) {
    const g = e.target.closest?.('.pl');
    if (!g) return;
    const list = [...this.dots.values()].filter((d) => d.d.p);
    const idx = list.findIndex((d) => d.g === g);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openCard(list[idx]);
    } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const next = list[(idx + step + list.length) % list.length];
      g.setAttribute('tabindex', '-1');
      next.g.setAttribute('tabindex', '0');
      next.g.focus();
    } else if (e.key === 'Escape') this.closeCard();
  }

  /** One tab stop for all the dots; arrow keys move between players. */
  rovingFocus() {
    const list = [...this.dots.values()].filter((d) => d.d.p);
    list.forEach((d, i) => d.g.setAttribute('tabindex', i === 0 ? '0' : '-1'));
  }

  openCard(dot) {
    const p = dot.d.p;
    const team = this.teams[dot.d.team];
    const { fill, ink } = ratingColor(p.r ?? 70);
    this.card.replaceChildren(
      h('div', { class: 'pcard-head' },
        h('span', { class: 'pcard-num', style: { background: team.color, color: inkOn(team.color) } }, p.num ?? ''),
        h('div', null, h('b', null, p.name || shortName(p)), h('small', null, `${POS_NAMES[p.pos] || p.pos} · ${team.name}`))),
      h('div', { class: 'pcard-stats' },
        h('div', null, h('span', { class: 'pcard-rating', style: { background: fill, color: ink } }, p.r ?? '–'), h('small', null, 'Rating')),
        h('div', null, h('b', { class: 'num' }, p.spd ? `${mph(p.spd)}` : '–'), h('small', null, 'Top speed, mph'))),
    );
    this.card.hidden = false;
    // place the card beside the dot, inside the field
    const box = this.el.getBoundingClientRect();
    const vb = this.svg.viewBox.baseVal;
    const px = ((X(dot.x) - vb.x) / vb.width) * box.width;
    const py = ((Y(dot.L) - vb.y) / vb.height) * box.height;
    const cw = this.card.offsetWidth;
    const chh = this.card.offsetHeight;
    const left = Math.max(8, Math.min(box.width - cw - 8, px - cw / 2));
    const top = py > box.height / 2 ? py - chh - 18 : py + 18;
    Object.assign(this.card.style, { left: `${left}px`, top: `${Math.max(8, Math.min(box.height - chh - 8, top))}px` });
  }

  closeCard() {
    this.card.hidden = true;
  }
}

/** Ball position at time t from its segments: [x, L, height, angle]. */
function ballAt(ch, t) {
  const segs = ch.ball;
  if (!segs.length) return [ch.end?.[0] ?? FIELD_W / 2, ch.end?.[1] ?? 50, 0, -90];
  let seg = segs[0];
  for (const sg of segs) if (sg.t0 <= t) seg = sg;
  if (seg.kind === 'fly') {
    const k = Math.max(0, Math.min(1, (t - seg.t0) / Math.max(0.01, seg.t1 - seg.t0)));
    const x = seg.from[0] + (seg.to[0] - seg.from[0]) * k;
    const L = seg.from[1] + (seg.to[1] - seg.from[1]) * k;
    const angle = (Math.atan2(-(seg.to[1] - seg.from[1]), seg.to[0] - seg.from[0]) * 180) / Math.PI;
    return [x, L, seg.h * 4 * k * (1 - k), angle];
  }
  if (seg.kind === 'rest') return [seg.at[0], seg.at[1], 0, 0];
  const tr = ch.tracks.get(seg.key);
  if (!tr) return [FIELD_W / 2, 50, 0, -90];
  const n = tr.length / 2;
  const i = Math.min(n - 1, Math.floor(t / ch.dt));
  const j = Math.min(n - 1, i + 1);
  const w = Math.min(1, t / ch.dt - i);
  const x = tr[2 * i] + (tr[2 * j] - tr[2 * i]) * w;
  const L = tr[2 * i + 1] + (tr[2 * j + 1] - tr[2 * i + 1]) * w;
  const dx = tr[2 * j] - tr[2 * i];
  const dL = tr[2 * j + 1] - tr[2 * i + 1];
  const moving = Math.hypot(dx, dL) > 0.01;
  const angle = moving ? (Math.atan2(-dL, dx) * 180) / Math.PI : -90;
  // carried in the arm, a little ahead of the body
  const off = moving ? 0.45 / Math.hypot(dx, dL) : 0;
  return [x + dx * off, L + dL * off, 0, angle];
}

function tween(ms, fn) {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const k = Math.min(1, (now - start) / ms);
      fn(k);
      if (k < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function legend() {
  return h('div', { class: 'legend', 'aria-hidden': 'true' },
    h('span', { class: 'lg-shape off' }), h('small', null, 'Offense'),
    h('span', { class: 'lg-shape def' }), h('small', null, 'Defense'),
    h('span', { class: 'lg-sep' }),
    h('small', null, 'Rating'), h('span', { class: 'lg-ramp' }), h('small', { class: 'lg-ends' }, '40–99'));
}

// --- the static turf ------------------------------------------------------------------------

function drawTurf(teams, me) {
  const g = s('g', { class: 'turf' });
  g.append(s('rect', { class: 'apron', x: 0, y: 0, width: WORLD_W, height: WORLD_H }));
  for (let L = 0; L < 100; L += 5) {
    g.append(s('rect', { class: (L / 5) % 2 ? 'stripe-b' : 'stripe-a', x: X(0), y: Y(L + 5), width: FIELD_W * U, height: 5 * U }));
  }
  // end zones: the user's at the bottom (L -10..0), the opponent's at the top (100..110)
  const zone = (team, L0) => {
    const z = s('g', { class: 'endzone' });
    z.append(s('rect', { x: X(0), y: Y(L0 + 10), width: FIELD_W * U, height: 10 * U, style: { fill: team.color } }));
    z.append(s('text', {
      class: 'ez-text', x: X(FIELD_W / 2), y: Y(L0 + 5), 'text-anchor': 'middle', dy: '0.35em',
      style: { fill: inkOn(team.color) === '#ffffff' ? '#ffffff' : '#0b1020' },
    }, team.name.toUpperCase()));
    return z;
  };
  g.append(zone(teams[me], -10), zone(teams[1 - me], 100));
  const lines = s('g', { class: 'lines' });
  for (let L = 0; L <= 100; L += 5) {
    lines.append(s('line', { class: L % 50 === 0 && L !== 50 ? 'goal' : L % 10 ? 'five' : 'ten', x1: X(0), x2: X(FIELD_W), y1: Y(L), y2: Y(L) }));
  }
  for (let L = 1; L < 100; L += 1) {
    if (L % 5 === 0) continue;
    const y = Y(L);
    for (const [a, b] of [[0.25, 0.9], [HASH_L - 0.33, HASH_L + 0.33], [HASH_R - 0.33, HASH_R + 0.33], [FIELD_W - 0.9, FIELD_W - 0.25]]) {
      lines.append(s('line', { class: 'hash', x1: X(a), x2: X(b), y1: y, y2: y }));
    }
  }
  lines.append(s('rect', { class: 'boundary', x: X(0), y: Y(110), width: FIELD_W * U, height: 120 * U }));
  g.append(lines);
  const nums = s('g', { class: 'yard-nums' });
  for (let L = 10; L <= 90; L += 10) {
    const label = String(L <= 50 ? L : 100 - L);
    const toward = L < 50 ? -1 : L > 50 ? 1 : 0;
    for (const [x, rot] of [[8.6, -90], [FIELD_W - 8.6, 90]]) {
      nums.append(s('text', { x: X(x), y: Y(L), transform: `rotate(${rot} ${X(x)} ${Y(L)})`, 'text-anchor': 'middle', dy: '0.35em' }, label));
      if (toward) {
        const ax = X(x);
        const ay = Y(L + toward * 2.6);
        const d = toward * 0.55 * U;
        nums.append(s('path', { class: 'arrow', d: `M${ax - 0.45 * U} ${ay + d}L${ax + 0.45 * U} ${ay + d}L${ax} ${ay - d}Z` }));
      }
    }
  }
  g.append(nums);
  // midfield emblem: a stopwatch reading 2:00
  const mx = X(FIELD_W / 2);
  const my = Y(50);
  const r = 4.4 * U;
  g.append(s('g', { class: 'midlogo' },
    s('circle', { cx: mx, cy: my, r, class: 'ml-ring' }),
    s('rect', { x: mx - 0.9 * U, y: my - r - 1.6 * U, width: 1.8 * U, height: 1.3 * U, rx: 2.5, class: 'ml-fill' }),
    s('text', { x: mx, y: my, dy: '0.36em', 'text-anchor': 'middle', class: 'ml-text' }, '2:00')));
  for (const L of [-10, 110]) {
    const y = Y(L);
    const w = 3.08 * U;
    g.append(s('g', { class: 'posts' },
      s('line', { x1: X(FIELD_W / 2) - w, x2: X(FIELD_W / 2) + w, y1: y, y2: y }),
      s('circle', { cx: X(FIELD_W / 2) - w, cy: y, r: 0.4 * U }),
      s('circle', { cx: X(FIELD_W / 2) + w, cy: y, r: 0.4 * U })));
  }
  return g;
}
