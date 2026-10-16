// Client for the optional leaderboard (server/worker.js). The URL comes from
// <meta name="board-api">; when it is empty no request is ever made and no board UI shows.

import { h } from './dom.js';
import { deviceToken, loadName } from './store.js';

export function boardUrl() {
  const raw = document.querySelector('meta[name="board-api"]')?.getAttribute('content')?.trim() || '';
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return u.protocol === 'https:' || local ? raw.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

async function call(path, body) {
  const base = boardUrl();
  if (!base) return null;
  const res = await fetch(`${base}${path}`, body ? {
    method: 'POST',
    // a "simple" request: no CORS preflight; the worker parses the body as JSON
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) throw new Error(`board ${res.status}`);
  return res.json();
}

/** Post today's finish (first finish of the day counts). Retries once after 5 s. */
export async function postDaily({ date, score, win }) {
  const body = { date, token: deviceToken(), score, win, name: loadName() || undefined };
  try {
    return await call('/daily', body);
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    return call('/daily', body).catch(() => null);
  }
}

export const getSurvivor = () => call('/survivor').catch(() => null);

export function postSurvivor({ streak }) {
  const name = loadName();
  if (!name) return getSurvivor();
  return call('/survivor', { token: deviceToken(), name, streak }).catch(() => null);
}

/** "Everyone today" box from a /daily answer. */
export function dailyBox(data, myScore) {
  if (!data) return h('div', { class: 'board muted small' }, 'The daily board could not be reached.');
  const max = Math.max(1, ...data.hist);
  const mine = Math.min(9, Math.floor((myScore ?? 0) / 10));
  return h('div', { class: 'board' },
    h('div', { class: 'eyebrow' }, 'Everyone today'),
    h('p', null, data.rank ? h('b', null, `#${data.rank} of ${data.n} today`) : `${data.n} played today`,
      data.mean != null ? ` · average ${Math.round(data.mean)}` : ''),
    h('div', { class: 'hist', role: 'img', 'aria-label': `Today's scores in tens: ${data.hist.join(', ')}` },
      data.hist.map((c, i) => h('span', { class: i === mine ? 'me' : '', style: { height: `${8 + (c / max) * 56}px` }, title: `${i * 10}–${i * 10 + 9}: ${c}` }))),
    h('div', { class: 'hist-axis', 'aria-hidden': 'true' }, h('span', null, '0'), h('span', null, '100')),
    data.top?.length ? [h('div', { class: 'mini-label' }, "Today's best"),
      h('ol', { class: 'top' }, data.top.slice(0, 10).map((r) => h('li', null, h('span', null, r.name), h('b', { class: 'num' }, Math.round(r.score)))))] : null);
}

/** Survivor board rows. */
export function survivorBox(data) {
  if (!data?.top) return null;
  const me = loadName();
  return h('div', { class: 'board' },
    h('div', { class: 'eyebrow' }, 'Survivor board'),
    data.top.length
      ? h('ol', { class: 'top' }, data.top.slice(0, 10).map((r) => h('li', { class: r.name === me ? 'me' : '' }, h('span', null, r.name), h('b', { class: 'num' }, r.best))))
      : h('p', { class: 'muted small' }, 'No runs on the board yet.'),
    me ? null : h('p', { class: 'muted small' }, 'Set your name on a run summary to get on the board.'));
}
