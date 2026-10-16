// Daily mode: one real late-game spot a day (by the player's local date), the end card,
// and the day summary with percentile, streak, look-alike, share text and countdown.

import { h, mount } from './dom.js';
import { introCard, endCard, lookalikeCard, squaresRow } from './cards.js';
import { GameView } from './game.js';
import { lastName, localDate, shortDate, signed } from './format.js';
import { icon } from './icons.js';
import { bind } from './keys.js';
import { boardUrl, dailyBox, postDaily } from './board.js';
import { dailyText, shareBox } from './share.js';
import { streak } from './stats.js';
import { loadDay, loadHistory, saveDay, saveHistory } from './store.js';

export async function runDaily(app) {
  const { lib } = app;
  const date = localDate();
  const dayN = lib.dayNumber(date);
  app.setSub(`No. ${dayN} · ${shortDate(date)}`);
  const spotId = lib.dailySpotId(date);
  let day = loadDay(date);
  if (!day || day.spotId !== spotId) day = { spotId, started: false, saved: null, done: false };
  if (day.done && day.end) {
    showSummary(app, { date, dayN, day });
    return;
  }
  const spot = await lib.loadSpot(spotId);
  let session = null;
  if (day.saved?.game) {
    try {
      session = await lib.resume(spot, day.saved.game);
    } catch {
      day.saved = null;   // an unreadable save: start the drive over
    }
  }
  session ??= lib.start(spot, { mode: 'daily' });
  const facts = session.facts();
  if (!day.started) {
    await new Promise((resolve) => {
      const { el, start } = introCard({
        facts, view: session.view(), eyebrow: `Today's drive · ${facts.category}`,
        onStart: () => { start.disabled = true; resolve(); },
      });
      mount(app.main, el);
      bind({ primary: start });
      start.focus();
    });
    day.started = true;
    saveDay(date, day);
  }
  const game = new GameView(app.main, session, {
    saved: day.saved,
    save: (snap) => { day.saved = snap; saveDay(date, day); },
  });
  const sum = await game.run();
  day = { spotId, started: true, saved: null, done: true, end: { sum, facts } };
  saveDay(date, day);
  const history = loadHistory();
  history.days[date] = {
    day: dayN, p: sum.percentile, coach: sum.lookalike?.name ?? null, vsTypical: sum.vsTypical,
    result: sum.result, team: facts.mine, marks: sum.squares,
  };
  // look-alike measures summed over every day played
  history.measures = lib.addMeasures(history.measures, sum.measures);
  saveHistory(history);
  const { el, button } = endCard({ sum, facts, button: { label: "Today's score", onClick: () => showSummary(app, { date, dayN, day }) } });
  game.showEnd(el);
  bind({ primary: button });
}

function vsLine(sum) {
  const r = sum.real;
  if (!r.verdict || !r.coach) return null;
  const who = lastName(r.coach);
  return { better: `You beat ${who}, the real coach`, worse: `${who}, the real coach, did better`, same: `Same result as ${who}, the real coach` }[r.verdict];
}

function showSummary(app, { date, dayN, day }) {
  const { sum, facts } = day.end;
  const history = loadHistory();
  const st = streak(history, date);
  const score = sum.percentile != null ? Math.round(sum.percentile * 100) : null;
  const text = dailyText({
    dayN, percentile: sum.percentile, coach: sum.lookalike?.name, team: facts.mine, result: sum.result,
    decisions: sum.decisions, streak: st,
  });
  const share = shareBox(text);
  const countdown = h('p', { class: 'countdown' });
  const boardSlot = h('div');
  const card = h('article', { class: 'card score-card' },
    h('div', { class: 'eyebrow' }, `Day ${dayN} · your score`),
    h('div', { class: 'big-score' }, h('b', { class: 'num' }, score ?? '–'), h('span', null, '%')),
    h('p', { class: 'big-caption' }, score != null ? `Better than ${score}% of NFL play-callers` : 'Score unavailable'),
    h('p', { class: 'streak' }, icon('flame'), st >= 2 ? `${st}-day streak` : 'Day 1 of your streak'),
    sum.decisions.length ? squaresRow(sum.decisions) : null,
    vsLine(sum) ? h('p', { class: ['vs-line', sum.real.verdict] }, vsLine(sum)) : null,
    lookalikeCard(sum.lookalike, 'Today you coached like'),
    sum.vsTypical != null ? h('p', { class: 'typical' }, h('b', { class: 'num' }, `${signed(sum.vsTypical)}%`), " win chance against a typical NFL play-caller on today's drive.") : null,
    share.el,
    countdown,
    boardSlot,
    h('a', { class: 'btn btn-secondary btn-block', href: '#survivor' }, 'Play Survivor while you wait'));
  mount(app.main, h('section', { class: 'screen summary' }, card));
  bind({ primary: share.button });
  tickCountdown(countdown, st);
  if (boardUrl() && score != null) {
    boardSlot.replaceChildren(h('p', { class: 'muted small' }, 'Loading today’s board…'));
    postDaily({ date, score, win: sum.result === 'W' }).then((data) => boardSlot.replaceChildren(dailyBox(data, score)));
  }
}

/** "Next drive in HH:MM:SS" until local midnight, then a button to play the new day. */
function tickCountdown(el, st) {
  const update = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const left = Math.max(0, Math.round((next - now) / 1000));
    if (left === 0 || !el.isConnected) {
      if (el.isConnected) el.replaceChildren(h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => location.reload() }, "Play today's drive"));
      return;
    }
    const pad = (n) => String(n).padStart(2, '0');
    el.replaceChildren(st >= 1 ? 'Keep the streak: next drive in ' : 'Next drive in ',
      h('b', { class: 'num' }, `${pad(Math.floor(left / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`));
    setTimeout(update, 1000 - (Date.now() % 1000));
  };
  update();
}
