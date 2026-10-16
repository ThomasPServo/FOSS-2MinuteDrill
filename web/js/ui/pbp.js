// Collapsible play-by-play, newest first; the user's own team's lines are bold.

import { h } from './dom.js';
import { clock as fmtClock } from './format.js';

const quarterName = (q) => (q == null ? '' : q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `OT${q - 4}`);

export class PlayByPlay {
  constructor(lines = []) {
    this.list = h('ol', { class: 'pbp-list' });
    this.el = h('details', { class: 'pbp' }, h('summary', null, 'Play-by-play'), this.list);
    this.lines = [];
    for (const l of lines) this.add(l);
  }

  /** Add one line: { text, mine, clock (seconds left in the quarter), qtr }. */
  add(line) {
    this.lines.push(line);
    const time = line.clock != null ? `${quarterName(line.qtr)} ${fmtClock(line.clock)}`.trim() : '';
    this.list.prepend(h('li', { class: line.mine ? 'mine' : '' }, h('span', { class: 'pbp-time num' }, time), h('span', null, line.text)));
  }
}
