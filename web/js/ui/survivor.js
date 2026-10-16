// Survivor mode: random real fourth quarters back to back until you lose one. A tie after
// overtime keeps the run alive without a win.

import { h, mount } from './dom.js';
import { introCard, endCard } from './cards.js';
import { GameView } from './game.js';
import { gameTag, plural } from './format.js';
import { bind } from './keys.js';
import { boardUrl, postSurvivor, survivorBox } from './board.js';
import { shareBox, survivorText } from './share.js';
import { loadName, loadRun, loadRunStats, saveName, saveRun, saveRunStats } from './store.js';

const random31 = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

function newRun() {
  return { id: random31(), games: [], played: [], tend: [], current: null, out: false };
}

const wins = (run) => run.games.filter((g) => g.r === 'W').length;

/** Header line and W/T/L tiles for the run so far. */
function header(app, run) {
  const best = loadRunStats().best || 0;
  const tiles = h('span', { class: 'tiles', 'aria-hidden': 'true' },
    run.games.length > 7 ? h('i', { class: 'tile-more' }, `+${run.games.length - 7}`) : null,
    run.games.slice(-7).map((g) => h('i', { class: `tile-${g.r}` }, g.r)),
    run.out ? null : h('i', { class: 'tile-now' }, run.games.length + 1));
  app.setSub(h('span', null, `Survivor · ${plural(wins(run), 'win')} · best ${best}`), tiles);
}

function pick(lib, run) {
  const pool = lib.survivorPool();
  const fresh = pool.filter((id) => !run.played.includes(id));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

export async function runSurvivor(app) {
  const { lib } = app;
  let run = loadRun();
  if (!run) {
    run = newRun();
    saveRun(run);
  }
  while (!run.out) {
    header(app, run);
    if (!run.current) {
      run.current = { spotId: pick(lib, run), seed: random31(), started: false, saved: null };
      saveRun(run);
    }
    const cur = run.current;
    const spot = await lib.loadSpot(cur.spotId);
    let session = null;
    if (cur.saved?.game) {
      try {
        session = await lib.resume(spot, cur.saved.game);
      } catch {
        cur.saved = null;
      }
    }
    session ??= lib.start(spot, { mode: 'survivor', seed: cur.seed, tendencies: run.tend || [] });
    const facts = session.facts();
    const n = run.games.length + 1;
    if (!cur.started) {
      await new Promise((resolve) => {
        const { el, start } = introCard({
          facts, view: session.view(), eyebrow: `Survivor · Game ${n}`,
          note: 'Win to stay alive. Lose and your run is over. Tied at the end: overtime.',
          onStart: () => { start.disabled = true; resolve(); },
        });
        mount(app.main, el);
        bind({ primary: start });
        start.focus();
      });
      cur.started = true;
      saveRun(run);
    }
    const game = new GameView(app.main, session, { saved: cur.saved, save: (snap) => { cur.saved = snap; saveRun(run); } });
    const sum = await game.run();
    const r = sum.result === 'W' ? 'W' : sum.result === 'L' ? 'L' : 'T';
    run.games.push({
      id: cur.spotId, r, mine: sum.mine, theirs: sum.theirs, ot: sum.ot, me: facts.mine, op: facts.opp,
      tag: gameTag(facts.season, facts.week, facts.type), marks: sum.squares,
    });
    run.played.push(cur.spotId);
    run.tend = session.tendencies;
    run.current = null;
    run.out = r === 'L';
    const stats = loadRunStats();
    stats.best = Math.max(stats.best || 0, wins(run));
    if (run.out) stats.runs = (stats.runs || 0) + 1;
    saveRunStats(stats);
    saveRun(run);
    header(app, run);
    const line = run.out
      ? h('p', { class: 'surv-line out' }, `Your run is over after ${plural(wins(run), 'win')}.`)
      : h('p', { class: 'surv-line alive' }, r === 'W' ? `Still alive: ${plural(wins(run), 'win')} and counting.` : 'A tie: still alive, no win added.');
    await new Promise((resolve) => {
      const { el, button } = endCard({ sum, facts, extra: line, button: { label: run.out ? 'Your run' : 'Next game', onClick: resolve } });
      game.showEnd(el);
      bind({ primary: button });
    });
  }
  showRunSummary(app, run);
}

function showRunSummary(app, run) {
  header(app, run);
  const w = wins(run);
  const stats = loadRunStats();
  const bestLine = w > 0 && w >= (stats.best || 0) ? 'Your best run yet.' : stats.best > 0 ? `Your best run: ${plural(stats.best, 'win')}.` : "One loss and it's over. Run it back.";
  const shareSlot = h('div');
  const boardSlot = h('div');
  const renderShare = () => {
    const box = shareBox(survivorText({ name: loadName(), games: run.games }), { label: 'Share your run', primary: false });
    shareSlot.replaceChildren(box.el);
    return box;
  };
  const again = h('button', {
    class: 'btn btn-primary btn-block', type: 'button',
    onclick: () => { again.disabled = true; saveRun(newRun()); runSurvivor(app); },
  }, 'New run', h('kbd', { class: 'kbd' }, '↵'));
  let nameForm = null;
  if (boardUrl()) {
    const input = h('input', { type: 'text', maxlength: 20, value: loadName(), placeholder: 'Your name for the board', 'aria-label': 'Your name for the board', autocomplete: 'nickname' });
    nameForm = h('form', { class: 'name-form', onsubmit: (e) => {
      e.preventDefault();
      saveName(input.value.trim().slice(0, 20));
      renderShare();
      postSurvivor({ streak: stats.best || 0 }).then((d) => boardSlot.replaceChildren(survivorBox(d) || ''));
    } }, input, h('button', { class: 'btn btn-secondary', type: 'submit' }, 'Save'));
    postSurvivor({ streak: stats.best || 0 }).then((d) => boardSlot.replaceChildren(survivorBox(d) || ''));
  }
  const card = h('article', { class: 'card score-card run-card' },
    h('div', { class: 'eyebrow' }, 'Survivor · run over'),
    h('div', { class: 'big-score' }, h('b', { class: 'num' }, w)),
    h('p', { class: 'big-caption' }, `${w === 1 ? 'Win' : 'Wins'} before you were knocked out`),
    h('p', { class: 'muted' }, bestLine),
    h('ol', { class: 'run-games' }, run.games.map((g) => h('li', { class: `g-${g.r}` },
      h('span', { class: ['grade', { W: 'g', T: 'y', L: 'r' }[g.r]], 'aria-label': { W: 'Win', T: 'Tie', L: 'Loss' }[g.r] }, g.r),
      h('span', { class: 'rg-main' }, h('b', { class: 'num' }, `${g.mine}–${g.theirs}${g.ot ? ' OT' : ''}`), ` ${g.me} vs ${g.op}`),
      h('small', { class: 'muted' }, g.tag)))),
    nameForm,
    shareSlot,
    again,
    boardSlot);
  mount(app.main, h('section', { class: 'screen summary' }, card));
  renderShare();
  bind({ primary: again });
}

