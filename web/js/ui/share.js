// Share text (emoji squares) and the share action: the system share sheet on phones,
// otherwise the clipboard, otherwise select the text for a manual copy.

import { h, toast } from './dom.js';
import { icon } from './icons.js';
import { markFor } from './session.js';

const SQUARE = { g: '🟩', y: '🟨', o: '🟧', r: '🟥' };
const RESULT_SQUARE = { W: '🟩', T: '🟨', L: '🟥' };

/** One square per decision, at most `max`: longer lists are averaged in contiguous groups. */
export function squares(decisions, max = 8) {
  const lost = decisions.map((d) => d.lost);
  if (lost.length <= max) return decisions.map((d) => SQUARE[d.mark]).join('');
  const out = [];
  for (let j = 0; j < max; j += 1) {
    const a = Math.floor((j * lost.length) / max);
    const b = Math.floor(((j + 1) * lost.length) / max);
    const group = lost.slice(a, b);
    out.push(SQUARE[markFor(group.reduce((x, y) => x + y, 0) / group.length)]);
  }
  return out.join('');
}

/** The page's own address without the hash, for share text. */
function siteUrl() {
  return `${location.origin}${location.pathname}`.replace(/index\.html$/, '');
}

export function dailyText({ dayN, percentile, coach, team, result, decisions, streak }) {
  return [
    `FOSS 2-Minute Drill #${dayN}`,
    percentile != null ? `Better than ${Math.round(percentile * 100)}% of NFL play-callers` : null,
    coach ? `Coached like ${coach}` : null,
    streak >= 2 ? `🔥 ${streak}-day streak` : null,
    `${team} ${result} ${squares(decisions)}`,
    siteUrl(),
  ].filter(Boolean).join('\n');
}

export function survivorText({ name, games }) {
  const wins = games.filter((g) => g.r === 'W').length;
  return [
    `FOSS 2-Minute Drill Survivor${name ? ` · ${name}` : ''}`,
    `Survived ${wins} game${wins === 1 ? '' : 's'}`,
    games.map((g) => RESULT_SQUARE[g.r]).join('') || '—',
    `${siteUrl()}#survivor`,
  ].join('\n');
}

const mobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/** Share box: the text in a read-only area plus a Share button. */
export function shareBox(text, { label = 'Share your score', primary = true } = {}) {
  // one row per line, plus one for each line long enough to wrap on a phone
  const rows = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 34)), 0);
  const area = h('textarea', { class: 'share-text', readonly: true, rows, 'aria-label': 'Share text' }, text);
  const btn = h('button', { class: ['btn', primary ? 'btn-primary' : 'btn-secondary', 'btn-block'], type: 'button' }, icon('share'), label);
  btn.addEventListener('click', async () => {
    if (mobile() && navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      area.focus();
      area.select();
      toast('Selected: copy it');
    }
  });
  return { el: h('div', { class: 'share' }, area, btn), button: btn };
}
