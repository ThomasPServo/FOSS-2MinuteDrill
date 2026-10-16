// A "scene" is every dot on the field for one moment: the 22 players in their pre-snap
// alignment (or a special-teams unit), the line of scrimmage and the ball's spot.

import {
  FIELD_W, defenseSet, groupOf, kickSet, kickoffSet, offenseSet, puntSet, toField,
} from './formation.js';

const ST_GROUP = {
  line: 'OL', LS: 'OL', wing: 'TE', H: 'QB', K: 'QB', P: 'QB', PP: 'RB', gunner: 'WR', rush: 'DL',
  jammer: 'CB', LB: 'LB', R: 'RB', cover: 'LB', setup: 'LB',
};

/**
 * @param view     session view of the moment (before the snap)
 * @param lineups  [lineup(team 0), lineup(team 1)] from the session
 * @param type     'snap' | 'under' | 'two' | 'fg' | 'xp' | 'punt' | 'kickoff'
 * @param look     defensive look shown ('base' | 'blitz' | 'load' | 'soft')
 * @param strong   +1 when the tight end lines up on the offense's right
 * @param ballX    lateral spot of the ball (yards from the screen's left sideline)
 */
export function buildScene({ view, lineups, type, look = 'base', strong = 1, ballX = FIELD_W / 2 }) {
  const off = view.offense;
  const def = 1 - off;
  const up = view.offenseUp;
  let los = view.los;
  if (type === 'two') los = up ? 98 : 2;
  if (type === 'kickoff') ballX = FIELD_W / 2;
  const ballU = up ? ballX : FIELD_W - ballX;
  const dots = [];
  const put = (o, isDef, dot) => dots.push({ ...dot, ...toField(o, { los, up, def: isDef }) });

  if (type === 'fg' || type === 'xp' || type === 'punt' || type === 'kickoff') {
    let sets;
    if (type === 'punt') {
      const p = puntSet(ballU, Math.max(20, Math.min(46, view.yl - 6)));
      sets = { kick: p.kick, recv: p.recv };
    } else if (type === 'kickoff') {
      const k = kickoffSet(100 - 35);
      sets = { kick: k.kick, recv: k.recv };
    } else {
      const k = kickSet(ballU);
      sets = { kick: k.kick, recv: k.rush };
    }
    const named = { K: lineups[off].k, P: lineups[off].p, H: lineups[off].p };
    sets.kick.forEach((o, i) => {
      const p = named[o.role] || null;
      put(o, false, { key: p ? `${off}:${o.role}` : `${off}:st:${i}`, team: off, unit: 'st', p, role: o.role, group: ST_GROUP[o.role] });
    });
    sets.recv.forEach((o, i) => put(o, true, { key: `${def}:st:${i}`, team: def, unit: 'st', p: null, role: o.role, group: ST_GROUP[o.role] }));
  } else {
    const o = offenseSet(lineups[off].off, { ballU, s: strong, under: type === 'under' });
    o.forEach((a, i) => put(a, false, { key: `${off}:off:${lineups[off].off.indexOf(a.p)}`, team: off, unit: 'off', p: a.p, group: groupOf(a.p.pos), slot: i }));
    // near a goal line the defense squeezes into the room it has (the end zone is 10 deep)
    const room = (up ? 109 - los : los + 9);
    const dset = defenseSet(lineups[def].def, o, { ballU, s: strong, look });
    const deepest = Math.max(...dset.map((a) => a.d));
    const squeeze = deepest > room ? Math.max(0.15, room / deepest) : 1;
    dset.forEach((a) => {
      put({ ...a, d: a.d * squeeze }, true, { key: `${def}:def:${lineups[def].def.indexOf(a.p)}`, team: def, unit: 'def', p: a.p, group: groupOf(a.p.pos) });
    });
  }
  for (const d of dots) d.L = Math.max(-9.4, Math.min(109.4, d.L));
  return { type, los, up, ballX, ltg: type === 'snap' || type === 'under' ? view.ltg : null, offense: off, look, dots };
}
