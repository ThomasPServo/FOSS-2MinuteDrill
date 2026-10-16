// Pre-snap alignments. Everything is worked out in the offense's frame — u = yards from the
// offense's left sideline (facing the defense), d = yards back from the line of scrimmage on
// the player's own side — and then placed on the field by toField().

export const FIELD_W = 160 / 3;          // 53.33 yards between the sidelines
export const HASH_L = 23.583;            // hash marks, yards from the left sideline (NFL: 70'9")
export const HASH_R = FIELD_W - HASH_L;
// Real line splits put linemen ~1.4 yards apart; dots that size would overlap on a phone, so
// the picture spreads every unit sideways (a drawing convention, not a measurement).
const OL_SPACING = 2.45;
const LINE_DEPTH = 1.35;

/** Position group for motion and layout. */
export function groupOf(pos) {
  switch (pos) {
    case 'T': case 'G': case 'C': case 'OT': case 'OG': case 'OL': case 'LS': return 'OL';
    case 'DE': case 'DT': case 'NT': case 'DL': case 'EDGE': return 'DL';
    case 'OLB': case 'ILB': case 'MLB': case 'LB': return 'LB';
    case 'CB': case 'DB': return 'CB';
    case 'FS': case 'SS': case 'S': case 'SAF': return 'S';
    case 'HB': case 'FB': case 'RB': return 'RB';
    case 'QB': case 'WR': case 'TE': case 'K': case 'P': return pos;
    default: return 'WR';
  }
}

const clampU = (u) => Math.max(1.2, Math.min(FIELD_W - 1.2, u));

/**
 * Offensive alignment. `s` = +1 when the strong side (tight end side) is the offense's right.
 * Returns [{ p, u, d }] in lineup order.
 */
export function offenseSet(players, { ballU, s = 1, under = false }) {
  const out = [];
  const by = (g) => players.filter((p) => groupOf(p.pos) === g);
  const ol = by('OL');
  // centre in the middle, then guards, tackles and extras alternating outward
  const rank = { C: 0, G: 1, OG: 1, T: 2, OT: 2 };
  const sortedOl = [...ol].sort((a, b) => (rank[a.pos] ?? 3) - (rank[b.pos] ?? 3));
  const slots = sortedOl.map((_, i) => (i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 ? -1 : 1)));
  const shift = sortedOl.length % 2 === 0 ? 0.5 : 0;
  sortedOl.forEach((p, i) => out.push({ p, u: ballU + (slots[i] + shift) * OL_SPACING, d: p.pos === 'C' ? LINE_DEPTH - 0.2 : LINE_DEPTH }));
  const lineEnd = (Math.ceil((sortedOl.length - 1) / 2) + shift) * OL_SPACING;
  let strongEnd = lineEnd;
  let weakEnd = lineEnd;

  by('TE').forEach((p, i) => {
    if (i === 0) { strongEnd += OL_SPACING; out.push({ p, u: ballU + s * strongEnd, d: LINE_DEPTH }); }
    else if (i === 1) { weakEnd += OL_SPACING; out.push({ p, u: ballU - s * weakEnd, d: LINE_DEPTH }); }
    else out.push({ p, u: ballU + s * (strongEnd + 2), d: 2.6 });
  });

  // receivers: X wide on the weak side, Z wide on the strong side, then slots
  const sideline = (side) => (side > 0 ? FIELD_W : 0);
  const wideU = (side) => sideline(side) - side * 7.5;
  const wr = by('WR');
  const plan = [
    { side: -s, wide: true, d: LINE_DEPTH },
    { side: s, wide: true, d: 2.4 },
    { side: s, wide: false, d: 2.4 },
    { side: -s, wide: false, d: 2.4 },
    { side: s, wide: false, d: 2.4, extra: true },
  ];
  wr.forEach((p, i) => {
    const pl = plan[i % plan.length];
    if (pl.wide) { out.push({ p, u: wideU(pl.side), d: pl.d }); return; }
    const end = ballU + pl.side * (pl.side === s ? strongEnd : weakEnd);
    const outer = wideU(pl.side);
    const u = pl.extra ? end + pl.side * 3 : end + (outer - end) * 0.45;
    out.push({ p, u, d: pl.d });
  });

  const qb = by('QB');
  qb.forEach((p, i) => out.push({ p, u: ballU + i * 2, d: under ? 2.8 : 5.6 }));
  by('RB').forEach((p, i) => {
    // under centre: tailback deep, a fullback (or second back) in front of him; gun: beside the QB
    if (under) out.push({ p, u: ballU, d: p.pos === 'FB' || i > 0 ? 5.2 : 7.6 });
    else out.push({ p, u: ballU + (i === 0 ? -s : s) * 2.5, d: 5.8 });
  });
  // anything else (K, P on the field by accident): line them up behind the QB
  for (const p of players) if (!out.some((o) => o.p === p)) out.push({ p, u: ballU, d: 8 });
  return out.map((o) => ({ ...o, u: clampU(o.u) }));
}

/**
 * Defensive alignment against an offensive set (from offenseSet), showing a look:
 * 'base' | 'blitz' | 'load' | 'soft'. Same frame as the offense (d = yards off the ball).
 */
export function defenseSet(players, offense, { ballU, s = 1, look = 'base' }) {
  const out = [];
  const by = (g) => players.filter((p) => groupOf(p.pos) === g);
  const olU = offense.filter((o) => groupOf(o.p.pos) === 'OL').map((o) => o.u - ballU);
  const lineEnd = olU.length ? Math.max(...olU.map(Math.abs)) : 2.9;

  // front: interior linemen centred, ends outside the tackles
  const dl = by('DL');
  const inside = dl.filter((p) => p.pos !== 'DE' && p.pos !== 'EDGE');
  const ends = dl.filter((p) => p.pos === 'DE' || p.pos === 'EDGE');
  const lbs = by('LB');
  const olbEdge = inside.length + ends.length <= 3 ? lbs.filter((p) => p.pos === 'OLB').slice(0, 2) : [];
  inside.forEach((p, i) => out.push({ p, u: ballU + (i - (inside.length - 1) / 2) * 2.9, d: LINE_DEPTH }));
  ends.forEach((p, i) => out.push({ p, u: ballU + (i % 2 ? -1 : 1) * s * (lineEnd + 1.8 + Math.floor(i / 2) * 2.4), d: LINE_DEPTH }));
  olbEdge.forEach((p, i) => out.push({ p, u: ballU + (i % 2 ? -1 : 1) * s * (lineEnd + 3.8), d: LINE_DEPTH + 0.4 }));

  // secondary over the receivers, widest first
  const wrs = offense.filter((o) => ['WR', 'TE', 'RB'].includes(groupOf(o.p.pos)) && o.d < 2)
    .sort((a, b) => Math.abs(b.u - ballU) - Math.abs(a.u - ballU));
  const cbs = by('CB');
  const soft = look === 'soft';
  const covered = new Set();
  cbs.forEach((p, i) => {
    const r = wrs[i];
    // corners take receivers split off the line; tight ends in line are left to the box
    if (r && Math.abs(r.u - ballU) > lineEnd + OL_SPACING + 0.5) {
      covered.add(r);
      const inside = Math.sign(ballU - r.u) * 0.7;
      const wide = Math.abs(r.u - ballU) > 12;
      out.push({ p, u: r.u + inside, d: soft ? 8.5 : wide ? 6.2 : 5.2 });
    } else {
      out.push({ p, u: ballU + s * 6, d: 9 });
    }
  });

  // linebackers: stack behind the line, shaded to the strong side
  const stack = lbs.filter((p) => !olbEdge.includes(p));
  const loaded = look === 'load';
  const spacing = (stack.length >= 3 ? 4.6 : 5.4) * (loaded ? 0.8 : 1);
  const lbPos = stack.map((p, i) => ({ p, u: ballU + s * 0.8 + (i - (stack.length - 1) / 2) * spacing, d: loaded ? 4.6 : 5.4 }));
  // an uncovered slot receiver pulls the widest linebacker out over him
  const openSlot = wrs.find((r) => !covered.has(r) && Math.abs(r.u - ballU) > lineEnd + 2);
  if (openSlot && lbPos.length) {
    const lb = lbPos.reduce((a, b) => (Math.abs(b.u - openSlot.u) < Math.abs(a.u - openSlot.u) ? b : a));
    lb.u = openSlot.u + Math.sign(ballU - openSlot.u) * 1.2;
    lb.d = 5.5;
  }
  if (soft && lbPos.length > 1) {
    const widest = lbPos.reduce((a, b) => (Math.abs(b.u - ballU) > Math.abs(a.u - ballU) ? b : a));
    widest.u = ballU - s * 7;
    widest.d = 6.2;
  }
  if (look === 'blitz') {
    lbPos.slice(0, 2).forEach((o, i) => { o.u = ballU + (i ? -s : s) * (1.5 + i * 2.6); o.d = 2.4; });
  }
  out.push(...lbPos);

  // safeties: two high over the hashes, or one in the middle; extras down in the box
  const safeties = by('S');
  safeties.forEach((p, i) => {
    let u;
    let d;
    if (safeties.length === 1) { u = FIELD_W / 2; d = 13; }
    else if (i < 2) { u = (i === 0 ? HASH_L - 1.5 : HASH_R + 1.5); d = 12.5; }
    else { u = ballU + s * 4; d = 7.5; }
    out.push({ p, u, d });
  });
  const strongSafety = out.filter((o) => groupOf(o.p.pos) === 'S').slice(-1)[0];
  if (strongSafety && loaded) { strongSafety.u = ballU + s * 4.5; strongSafety.d = 7.2; }
  if (strongSafety && soft) for (const o of out) if (groupOf(o.p.pos) === 'S') o.d += 2;

  for (const p of players) if (!out.some((o) => o.p === p)) out.push({ p, u: ballU, d: 6 });
  return out.map((o) => ({ ...o, u: clampU(o.u) }));
}

// --- special teams (generic bodies; d < 0 means ahead of the ball) ---------------------------------

/** Field goal / extra point: kicking unit and the rush. */
export function kickSet(ballU) {
  const kick = [];
  for (let i = 0; i < 7; i += 1) kick.push({ role: i === 3 ? 'LS' : 'line', u: ballU + (i - 3) * 1.9, d: 1.1 });
  kick.push({ role: 'wing', u: ballU - 7.2, d: 1.9 }, { role: 'wing', u: ballU + 7.2, d: 1.9 });
  kick.push({ role: 'H', u: ballU, d: 7 }, { role: 'K', u: ballU - 1.6, d: 9.4 });
  const rush = [];
  for (let i = 0; i < 9; i += 1) rush.push({ role: 'rush', u: ballU + (i - 4) * 1.9, d: 1.2 });
  rush.push({ role: 'LB', u: ballU - 3.2, d: 4.5 }, { role: 'LB', u: ballU + 3.2, d: 4.5 });
  return { kick, rush };
}

/** Punt: shield, gunners and punter; the return team with its returner `deep` yards away. */
export function puntSet(ballU, deep) {
  const kick = [];
  for (let i = 0; i < 7; i += 1) kick.push({ role: i === 3 ? 'LS' : 'line', u: ballU + (i - 3) * 1.9, d: 1.1 });
  kick.push({ role: 'gunner', u: 6.5, d: 1.0 }, { role: 'gunner', u: FIELD_W - 6.5, d: 1.0 });
  kick.push({ role: 'PP', u: ballU + 0.8, d: 5.2 }, { role: 'P', u: ballU, d: 14.5 });
  const recv = [];
  for (let i = 0; i < 6; i += 1) recv.push({ role: 'rush', u: ballU + (i - 2.5) * 2.2, d: 1.2 });
  recv.push({ role: 'jammer', u: 7.5, d: 1.2 }, { role: 'jammer', u: FIELD_W - 7.5, d: 1.2 });
  recv.push({ role: 'LB', u: ballU - 2, d: 6 }, { role: 'LB', u: ballU + 3, d: 11 });
  recv.push({ role: 'R', u: ballU, d: deep });
  return { kick, recv };
}

/** Kickoff under the 2024+ rules: cover men 25 yards ahead, a setup zone, two returners. */
export function kickoffSet(toGoal) {
  const kick = [{ role: 'K', u: FIELD_W / 2, d: 3.5 }];
  for (let i = 0; i < 10; i += 1) kick.push({ role: 'cover', u: 3.5 + i * 5.15 + (i >= 5 ? 0.6 : 0), d: -25 });
  const recv = [];
  for (let i = 0; i < 9; i += 1) recv.push({ role: 'setup', u: 4.2 + i * 5.6, d: i % 2 ? 34 : 31 });
  recv.push({ role: 'R', u: FIELD_W / 2 - 5, d: toGoal - 8 }, { role: 'R', u: FIELD_W / 2 + 4, d: toGoal - 3 });
  return { kick, recv };
}

/**
 * Place a frame position on the field: returns { x, L } where x = yards from the screen's
 * left sideline and L = yards from the user's goal line. `up` = the offense drives up the
 * screen; `def` = this player is on the defense.
 */
export function toField({ u, d }, { los, up, def = false }) {
  const x = up ? u : FIELD_W - u;
  const toward = up ? 1 : -1;
  return { x, L: los + (def ? d : -d) * toward };
}

/** Where the ball is spotted for the next snap: between the hashes, nearest to `x`. */
export const spotBall = (x) => Math.max(HASH_L, Math.min(HASH_R, x));
