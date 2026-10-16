// The result card after a snap: what happened, where the real play came from, how the call
// graded, and how the play moved the win chance.

import { h } from './dom.js';
import { pct, pct1, signed, signedInt } from './format.js';
import { icon } from './icons.js';

/** Tone of a win-chance swing (unrounded change in probability). */
function swingTone(d) {
  if (d >= 0.02) return 'g';
  if (d > -0.02) return 'y';
  if (d > -0.08) return 'o';
  return 'r';
}

function verdict(g) {
  if (!g.best || !g.chosen) return null;
  if (g.chosen.best || g.lost < 0.05) return [h('b', null, 'The best call here.')];
  if (g.mark === 'g') return ['As good as any. ', h('b', null, g.best.label), ` scored ${signed(g.lost)} more.`];
  const word = { y: 'Close', o: 'Costly', r: 'A big miss' }[g.mark];
  return [`${word}: `, h('b', null, g.best.label), ` was better (${signed(g.lost)} win chance).`];
}

function optionsTable(g) {
  const rows = g.options.map((o) => h('tr', { class: [o.chosen && 'you', o.best && 'best'] },
    h('td', null, o.best ? h('span', { class: 'star', 'aria-label': 'best' }, '★ ') : null, o.label, o.chosen ? h('span', { class: 'you-tag' }, ' you') : null),
    h('td', { class: 'num' }, o.freq != null && o.freq >= 0.005 ? pct(o.freq) : '–'),
    h('td', { class: 'num' }, pct1(o.wp))));
  return h('details', { class: 'options' },
    h('summary', null, 'How every option scored'),
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Option'), h('th', null, 'NFL'), h('th', null, 'Win'))),
      h('tbody', null, rows)),
    h('p', { class: 'fine' }, '“NFL” is how often play-callers make that choice in this spot. “Win” is your simulated win chance with it.'));
}

/**
 * @param r       normalised act result from the session
 * @param opts    { onReplay?, compact? }
 */
export function resultCard(r, { onReplay } = {}) {
  const main = r.main;
  const hasWp = r.wpBefore != null && r.wpAfter != null;
  const g = r.grade;
  let square;
  if (hasWp && main) {
    const d = Math.round(r.wpAfter * 100) - Math.round(r.wpBefore * 100);
    const tone = swingTone(r.wpAfter - r.wpBefore);
    square = h('div', { class: ['swing', tone], role: 'img', 'aria-label': `Your win chance ${d >= 0 ? 'up' : 'down'} ${Math.abs(d)} points` },
      h('b', { class: 'num' }, signedInt(d)), h('small', null, 'win %'));
  } else if (g) {
    square = h('div', { class: ['swing', g.mark], role: 'img', 'aria-label': g.word }, h('b', null, g.symbol), h('small', null, 'call'));
  }
  const extras = r.entries.filter((e) => e !== main && e.text && e.kind !== 'runoff');
  return h('article', { class: ['result', main?.mine === false && 'theirs'] },
    h('div', { class: 'result-top' },
      square || null,
      h('div', { class: 'result-main' },
        h('h3', { class: 'headline' }, r.headline || 'Play over'),
        main?.text ? h('p', { class: 'narr' }, main.text) : null,
        extras.length ? h('p', { class: 'narr extra' }, extras.map((e) => e.text).join(' · ')) : null,
        main?.provenance ? h('p', { class: 'prov' }, h('span', { class: 'prov-tag' }, 'Real play'), main.provenance) : null)),
    hasWp ? h('div', { class: 'wp-line' },
      'Win chance ', h('b', { class: 'num' }, pct(r.wpBefore)), h('span', { class: 'arrow', 'aria-hidden': 'true' }, ' → '),
      h('span', { class: 'sr-only' }, ' to '), h('b', { class: 'num' }, pct(r.wpAfter)),
      onReplay ? h('button', { class: 'chip replay', type: 'button', onclick: onReplay }, icon('replay'), 'Replay') : null) : null,
    g ? h('div', { class: ['verdict', g.mark] },
      h('span', { class: ['grade', g.mark], 'aria-hidden': 'true' }, g.symbol),
      h('p', null, h('span', { class: 'sr-only' }, `${g.word}. `), verdict(g))) : null,
    g && g.options.length > 1 ? optionsTable(g) : null);
}

/** One-sentence summary of a result for the screen-reader live region. */
export function announceText(r) {
  const parts = [r.headline, r.main?.text];
  if (r.wpBefore != null && r.wpAfter != null) parts.push(`Win chance ${pct(r.wpBefore)} to ${pct(r.wpAfter)}`);
  if (r.grade) parts.push(`Your call: ${r.grade.word}`);
  return parts.filter(Boolean).join('. ');
}
