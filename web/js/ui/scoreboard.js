// The broadcast-style score bar: both teams (away left, home right) with timeouts and
// possession, the quarter and game clock, and the down-and-distance strip under it.

import { h } from './dom.js';
import { clock as fmtClock } from './format.js';

export class Scoreboard {
  constructor() {
    this.clockEl = h('span', { class: 'sb-clock num' });
    this.quarterEl = h('span', { class: 'sb-q' });
    this.downEl = h('div', { class: 'sb-down' });
    this.sides = [1, 0].map(() => h('div', { class: 'sb-team' }));
    this.el = h('div', { class: 'sb', role: 'group', 'aria-label': 'Scoreboard' },
      h('div', { class: 'sb-row' },
        this.sides[0],
        h('div', { class: 'sb-mid' }, this.quarterEl, this.clockEl),
        this.sides[1]),
      this.downEl);
  }

  /** Render a session view. */
  render(view) {
    this.view = view;
    [1, 0].forEach((i, k) => this.renderTeam(this.sides[k], view.teams[i], k === 1));
    this.quarterEl.textContent = view.quarter;
    this.setClock(view.clock, view.running ? 'running' : 'stopped');
    const clockWord = view.done ? '' : view.phase !== 'snap' ? '' : view.running ? ' · clock running' : ' · clock stopped';
    this.downEl.replaceChildren(h('b', null, view.situation.split(' · ')[0]), view.situation.split(' · ').slice(1).map((t) => ` · ${t}`).join(''), clockWord);
    const [away, home] = [view.teams[1], view.teams[0]];
    this.el.setAttribute('aria-label',
      `${away.name} ${away.score}, ${home.name} ${home.score}. ${view.quarter} ${view.clockText}. ${view.situation}.`);
  }

  renderTeam(el, t, home) {
    el.className = ['sb-team', home ? 'home' : 'away', t.isMe && 'me', t.hasBall && 'ball'].filter(Boolean).join(' ');
    const pips = h('span', { class: 'sb-pips', 'aria-label': `${t.timeouts} timeouts left` },
      [0, 1, 2].map((i) => h('i', { class: i < t.timeouts ? 'on' : '' })));
    el.replaceChildren(
      h('span', { class: 'sb-stripe', style: { background: t.color } }),
      h('span', { class: 'sb-id' },
        h('span', { class: 'sb-abbr' }, t.abbr, t.hasBall ? h('i', { class: 'sb-poss', 'aria-label': 'has the ball' }) : null),
        h('span', { class: 'sb-meta' }, t.isMe ? h('span', { class: 'you' }, 'YOU') : null, pips)),
      h('span', { class: 'sb-score num' }, t.score));
  }

  /** Clock display; state 'running' | 'stopped' | 'runoff' (pre-snap time burning). */
  setClock(secs, state) {
    this.clockEl.textContent = fmtClock(secs);
    this.clockEl.dataset.state = state;
  }
}
