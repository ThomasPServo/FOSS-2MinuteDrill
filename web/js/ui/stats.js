// Your stats (daily history, streak, survivor best) and the help sheet.

import { h } from './dom.js';
import { daysBetween, localDate, plural } from './format.js';
import { openModal } from './modal.js';
import { loadHistory, loadRunStats } from './store.js';
import { boardUrl, getSurvivor, survivorBox } from './board.js';
import { symbolOf } from './session.js';
import { lookalikeCard } from './cards.js';

const BUCKETS = [[80, 100, '80–100'], [60, 79, '60–79'], [40, 59, '40–59'], [20, 39, '20–39'], [0, 19, '0–19']];

/** Consecutive days played ending today (or yesterday, if today is still to play). */
export function streak(history, today = localDate()) {
  const days = new Set(Object.keys(history.days || {}));
  let d = today;
  if (!days.has(d)) d = shiftDate(d, -1);
  let n = 0;
  while (days.has(d)) {
    n += 1;
    d = shiftDate(d, -1);
  }
  return n;
}

function shiftDate(date, by) {
  const t = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + by);
  return localDate(t);
}

/** Stats sheet; `lib` (may be null while loading) gives the look-alike over every day played. */
export function openStats(lib) {
  const hist = loadHistory();
  const days = Object.entries(hist.days || {}).sort(([a], [b]) => daysBetween(b, a));
  const scores = days.map(([, d]) => Math.round((d.p ?? 0) * 100));
  const today = localDate();
  const todayScore = hist.days?.[today] ? Math.round((hist.days[today].p ?? 0) * 100) : null;
  const best = scores.length ? Math.max(...scores) : null;
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const counts = BUCKETS.map(([lo, hi]) => scores.filter((s) => s >= lo && s <= hi).length);
  const max = Math.max(1, ...counts);
  const coach = lib && hist.measures ? lib.lookalike(hist.measures) : null;
  const run = loadRunStats();
  const boardSlot = h('div');
  const body = h('div', { class: 'stats' },
    h('div', { class: 'tiles' },
      tile(days.length, 'Played'),
      tile(avg ?? '–', 'Average score'),
      tile(streak(hist, today), 'Day streak'),
      tile(best ?? '–', 'Best day')),
    h('div', { class: 'mini-label' }, 'Your daily scores (better than N% of NFL play-callers)'),
    h('div', { class: 'bars', role: 'img', 'aria-label': `Days by score: ${BUCKETS.map(([, , l], i) => `${l}: ${counts[i]}`).join(', ')}` },
      BUCKETS.map(([lo, hi, label], i) => h('div', { class: ['bar-row', todayScore != null && todayScore >= lo && todayScore <= hi && 'today'] },
        h('span', { class: 'bar-label num' }, label),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${Math.max(counts[i] ? 8 : 0, (counts[i] / max) * 100)}%` } })),
        h('b', { class: 'num' }, counts[i])))),
    coach ? lookalikeCard(coach, `Over ${plural(days.length, 'day')} you coach most like`) : h('p', { class: 'muted' }, 'Play a few days to find the NFL coach you call most like.'),
    h('p', null, 'Survivor: ', h('b', null, `best run ${plural(run.best || 0, 'win')}`), ` (${plural(run.runs || 0, 'run')}).`),
    boardSlot);
  openModal('Your stats', body);
  if (boardUrl()) getSurvivor().then((data) => { const box = survivorBox(data); if (box) boardSlot.replaceChildren(box); });
}

function tile(value, label) {
  return h('div', { class: 'tile' }, h('b', { class: 'num' }, value), h('small', null, label));
}

const GRADES = [
  ['g', 'Good', 'The best call, or within half a point of win chance of it.'],
  ['y', 'Close', 'Cost up to 2 points of win chance.'],
  ['o', 'Costly', 'Cost 2 to 5 points of win chance.'],
  ['r', 'Big miss', 'Cost more than 5 points of win chance.'],
];

/** The help sheet; `first` adds a "Let's go" button for the first visit. */
export function openHelp({ first = false } = {}) {
  let close;
  const body = h('div', { class: 'help' },
    h('div', { class: 'help-modes' },
      h('div', null, h('h3', null, 'One drive a day'),
        h('ol', null,
          h('li', null, 'Each day brings a real late-game spot from a recent NFL season.'),
          h('li', null, 'You call every play for one team to the end of the game: runs, passes, timeouts, kicks, and the defense too.'),
          h('li', null, 'Every snap is a real NFL play of the call you picked, and every call is graded by simulated win chance.'))),
      h('div', null, h('h3', null, 'Survivor'),
        h('p', null, 'Random real fourth quarters, back to back. Win to stay alive; lose once and the run is over.'))),
    h('h3', null, 'How your calls grade'),
    h('ul', { class: 'grade-key' }, GRADES.map(([m, word, text]) => h('li', null, h('span', { class: ['grade', m], 'aria-hidden': 'true' }, symbolOf(m)), h('b', null, word), h('span', null, text)))),
    h('p', { class: 'small muted' }, 'On the field, dots are players coloured by rating (red is weaker, green stronger). Circles are on offense, squares on defense. Tap one for his card. Your end zone is at the bottom.'),
    h('p', { class: 'small' }, 'Keys: 1–9 pick a menu item, Enter or Space for the main button, Backspace to go back, Esc to close.'),
    h('p', { class: 'small' }, h('a', { href: 'how-it-works.html' }, 'How it works'), ' · ', h('a', { href: 'about.html' }, 'About, data and privacy')),
    h('p', { class: 'fine' }, 'Fan-made and open source. Not affiliated with, endorsed by or sponsored by the NFL or its teams. Team names are trademarks of their owners, used only to identify real games.'),
    first ? h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => close() }, "Let's go") : null);
  close = openModal(first ? 'Welcome to the 2-Minute Drill' : 'How to play', body);
}
