// The scenario card shown before a game, and the end-of-game card shown after it.

import { h, s } from './dom.js';
import {
  ballOn, clock as fmtClock, downDistance, gameTag, lastName, plural, signed,
} from './format.js';
import { symbolOf } from './session.js';
import { inkOn } from './teams.js';

function stateLine(margin) {
  if (margin > 0) return `Up by ${margin}`;
  if (margin < 0) return `Down by ${-margin}`;
  return 'Tied';
}

/** A slim horizontal field: both end zones, the ball and the line to gain. */
function fieldStrip(view) {
  const W = 320;
  const H = 34;
  const x = (L) => 20 + (L / 100) * (W - 40);   // user's goal on the left, attacking right
  const mine = view.teams[view.me];
  const opp = view.teams[1 - view.me];
  const g = s('svg', { class: 'strip', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Ball on ${ballOn(view.yl, view.userHasBall)}` });
  g.append(s('rect', { x: 0, y: 4, width: 20, height: H - 8, rx: 3, style: { fill: mine.color } }));
  g.append(s('rect', { x: W - 20, y: 4, width: 20, height: H - 8, rx: 3, style: { fill: opp.color } }));
  g.append(s('rect', { class: 'strip-turf', x: 20, y: 4, width: W - 40, height: H - 8 }));
  for (let L = 10; L < 100; L += 10) g.append(s('line', { class: L === 50 ? 'strip-mid' : 'strip-line', x1: x(L), x2: x(L), y1: 6, y2: H - 6 }));
  if (view.ltg != null) {
    g.append(s('rect', { class: 'strip-gain', x: Math.min(x(view.los), x(view.ltg)), y: 6, width: Math.abs(x(view.ltg) - x(view.los)), height: H - 12 }));
  }
  const bx = x(view.los ?? 50);
  g.append(s('line', { class: 'strip-los', x1: bx, x2: bx, y1: 3, y2: H - 3 }));
  g.append(s('ellipse', { class: 'strip-ball', cx: bx, cy: H / 2, rx: 6, ry: 3.8 }));
  const dir = view.userHasBall ? 1 : -1;
  g.append(s('path', { class: 'strip-arrow', d: `M${bx + dir * 10} ${H / 2 - 4} l${dir * 6} 4 l${-dir * 6} 4z` }));
  for (const [t, xx] of [[mine, 10], [opp, W - 10]]) {
    g.append(s('text', { x: xx, y: H / 2, dy: '0.35em', 'text-anchor': 'middle', class: 'strip-abbr', transform: `rotate(-90 ${xx} ${H / 2})`, style: { fill: inkOn(t.color) } }, t.abbr));
  }
  return g;
}

function teamSide(t, home) {
  return h('div', { class: ['m-side', home ? 'home' : 'away', t.isMe && 'me'] },
    h('span', { class: 'm-swatch', style: { background: `linear-gradient(135deg, ${t.color} 0 62%, ${t.alt} 62% 100%)` } }),
    h('span', { class: 'm-name' }, h('small', null, t.place), h('b', null, t.name)),
    h('span', { class: 'm-role' }, t.isMe ? h('span', { class: 'you' }, 'YOU') : home ? 'Home' : 'Away'));
}

/**
 * @param facts    session.facts()
 * @param view     session.view() at the start
 * @param eyebrow  category line, e.g. "Today's drive · Two-minute drill"
 * @param note     optional extra paragraph (survivor rules, a featured story)
 */
export function introCard({ facts, view, eyebrow, note, onStart }) {
  const mine = view.teams[view.me];
  const opp = view.teams[1 - view.me];
  const away = view.teams[1];
  const home = view.teams[0];
  const halfWord = view.quarter === 'Q2' ? 'half' : 'game';
  const start = h('button', { class: 'btn btn-primary btn-block start', type: 'button', onclick: onStart }, 'Take the field', h('kbd', { class: 'kbd' }, '↵'));
  const card = h('article', { class: 'card intro-card' },
    h('div', { class: 'intro-top', style: { '--c1': away.color, '--c2': home.color } },
      h('div', { class: 'eyebrow' }, eyebrow),
      h('div', { class: 'intro-tag' }, `${gameTag(facts.season, facts.week, facts.type)} · ${away.abbr} at ${home.abbr}`),
      h('h1', { class: 'intro-state' }, stateLine(view.margin)),
      h('p', { class: 'intro-time' }, h('b', { class: 'num' }, fmtClock(view.clock)), ` left in the ${halfWord}`)),
    h('div', { class: 'intro-body' },
      h('div', { class: 'matchup' },
        teamSide(away, false),
        h('div', { class: 'm-score num' }, h('b', null, away.score), h('span', null, '–'), h('b', null, home.score)),
        teamSide(home, true)),
      fieldStrip(view),
      h('ul', { class: 'facts' },
        h('li', null, h('span', null, view.userHasBall ? 'Your ball' : `${opp.name} ball`), h('b', null, `${downDistance(view.down, view.ytg, view.yl)} on ${ballOn(view.yl, view.userHasBall)}`)),
        h('li', null, h('span', null, 'Your timeouts'), h('b', null, pips(mine.timeouts))),
        h('li', null, h('span', null, `${opp.name} timeouts`), h('b', null, pips(opp.timeouts)))),
      note ? h('p', { class: 'intro-note' }, note) : null,
      h('p', { class: 'challenge' }, `You're calling it for the ${mine.name}.`, facts.coach ? [' Can you do better than ', h('b', null, facts.coach), ' did?'] : null),
      start,
      h('p', { class: 'fine' }, 'Every snap is a real NFL play of the call you make. Fan-made and open source; not affiliated with the NFL.')));
  return { el: h('section', { class: 'screen intro' }, card), start };
}

function pips(n) {
  return h('span', { class: 'pips', 'aria-label': `${n} left` }, [0, 1, 2].map((i) => h('i', { class: i < n ? 'on' : '' })));
}

const DRIVE_WORDS = {
  touchdown: 'the drive ended in a touchdown',
  'field goal': 'the drive ended in a field goal',
  punt: 'the drive ended in a punt',
  turnover: 'the drive ended in a turnover',
  'turnover on downs': 'the drive ended in a turnover on downs',
  'missed field goal': 'the drive ended in a missed field goal',
  'defensive touchdown': 'the defense scored on the drive',
  safety: 'the drive ended in a safety',
};

function realLine(sum, facts) {
  const r = sum.real;
  if (!r.coach || !r.callLabel) return null;
  const drive = String(r.drive || '').toLowerCase();
  let ending;
  if (drive.includes('ran out') || drive.includes('end of')) ending = facts.startScore.mine > facts.startScore.opp ? 'they ran out the clock' : 'time ran out on them';
  else ending = DRIVE_WORDS[drive] || (drive ? `the drive ended: ${drive}` : null);
  return h('p', { class: 'real-line' }, `In the real game (${gameTag(facts.season, facts.week, facts.type)}), ${r.coach} called `,
    h('b', null, `“${r.callLabel}”`), ' here', ending ? `; ${ending}.` : '.');
}

function vsCoach(sum) {
  const r = sum.real;
  if (!r.verdict || !r.coach) return null;
  const who = lastName(r.coach);
  const word = (a, b) => (a > b ? 'Won' : a < b ? 'Lost' : 'Tied');
  const pts = (n) => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Math.abs(n)} point${Math.abs(n) === 1 ? '' : 's'}`;
  let mine;
  let real;
  if (r.points) {
    mine = `${pts(r.points.mine)} before the half`;
    real = `${r.drive || 'No score'} (${pts(r.points.theirs)})`;
  } else if (r.final) {
    mine = `${word(sum.mine, sum.theirs)} ${sum.mine}–${sum.theirs}${sum.ot ? ' (OT)' : ''}`;
    real = `${word(r.final.mine, r.final.opp)} ${r.final.mine}–${r.final.opp}`;
  } else return null;
  const head = { better: `You beat ${who}`, worse: `${who} did better`, same: `Same result as ${who}` }[r.verdict];
  return h('div', { class: ['vs', r.verdict] },
    h('div', { class: 'vs-head' }, head),
    h('div', { class: 'vs-rows' },
      h('div', null, h('span', null, 'You'), h('b', { class: 'num' }, mine)),
      h('div', null, h('span', null, who), h('b', { class: 'num' }, real))));
}

/** "Coached like" card from an engine lookalike. */
export function lookalikeCard(look, heading) {
  if (!look?.name) return null;
  const reasons = look.reasons?.length
    ? `Like him, you ${look.reasons.join(', and ')}.`
    : 'Your calls sit close to his across the board.';
  const years = look.from && look.to ? (look.from === look.to ? String(look.from) : `${look.from}–${look.to}`) : null;
  const meta = [look.teams?.length ? look.teams.join(' · ') : null, years].filter(Boolean).join(' · ');
  return h('div', { class: 'lookalike' },
    h('div', { class: 'eyebrow' }, heading),
    h('div', { class: 'll-name' }, look.name),
    h('p', null, reasons),
    meta ? h('small', { class: 'muted' }, meta) : null);
}

export function squaresRow(decisions) {
  return h('div', { class: 'squares', role: 'img', 'aria-label': `Your calls: ${decisions.map((d) => d.mark).join(' ')}` },
    decisions.map((d) => h('span', { class: ['grade', d.mark], title: d.label ? `${d.label}${d.lost >= 0.05 ? ` (${signed(-d.lost)})` : ''}` : '' }, symbolOf(d.mark))));
}

/** Headline for the final result. */
function endHeadline(sum) {
  if (sum.half) return `Halftime: ${sum.mine}–${sum.theirs}`;
  const score = `${sum.mine}–${sum.theirs}`;
  if (sum.result === 'W') return `You win ${score}${sum.ot ? ' in overtime' : ''}`;
  if (sum.result === 'L') return `You lose ${score}${sum.ot ? ' in overtime' : ''}`;
  return `Tie ${score} after overtime`;
}

/**
 * @param sum      session.summary()
 * @param facts    session.facts()
 * @param button   { label, onClick }
 * @param extra    optional node (survivor status line)
 */
export function endCard({ sum, facts, button, extra }) {
  const btn = h('button', {
    class: 'btn btn-primary btn-block', type: 'button',
    onclick: () => { btn.disabled = true; button.onClick(); },
  }, button.label, h('kbd', { class: 'kbd' }, '↵'));
  const card = h('article', { class: ['card', 'end-card', `res-${sum.result}`] },
    h('div', { class: 'eyebrow' }, sum.half ? 'End of the half' : sum.ot ? 'Final · overtime' : 'Final'),
    h('h2', { class: 'end-head' }, endHeadline(sum)),
    extra || null,
    (sum.half || sum.result === 'T') && sum.winChance != null
      ? h('p', { class: 'muted' }, `Your win chance from here: ${(sum.winChance * 100).toFixed(1)}%`) : null,
    sum.decisions.length ? [h('div', { class: 'mini-label' }, `Your calls · ${plural(sum.decisions.length, 'decision')}`), squaresRow(sum.decisions)] : null,
    vsCoach(sum),
    realLine(sum, facts),
    lookalikeCard(sum.lookalike, 'You called this one like'),
    sum.vsTypical != null ? h('p', { class: 'typical' }, h('b', { class: 'num' }, `${signed(sum.vsTypical)}%`), ' win chance against a typical NFL play-caller in this spot.') : null,
    btn);
  return { el: card, button: btn };
}

