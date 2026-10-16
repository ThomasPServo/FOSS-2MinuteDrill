// FOSS 2-Minute Drill: entry point. Boots the engine, wires the header and runs the
// daily or survivor mode (URL hash #daily / #survivor).

import { h, mount } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { installKeys } from './ui/keys.js';
import { loadLibrary } from './ui/session.js';
import { openHelp, openStats } from './ui/stats.js';
import { helpSeen, markHelpSeen } from './ui/store.js';
import { runDaily } from './ui/daily.js';
import { runSurvivor } from './ui/survivor.js';

const main = document.getElementById('app');
const sub = document.getElementById('subbar');
const mode = location.hash === '#survivor' ? 'survivor' : 'daily';

function setupHeader(app) {
  for (const a of document.querySelectorAll('.mode')) {
    if (a.dataset.mode === mode) a.setAttribute('aria-current', 'page');
  }
  const stats = document.querySelector('[data-open="stats"]');
  const help = document.querySelector('[data-open="help"]');
  stats.append(icon('stats'));
  help.append(icon('help'));
  stats.addEventListener('click', () => openStats(app.lib));
  help.addEventListener('click', () => openHelp());
  // switching modes starts that mode fresh
  window.addEventListener('hashchange', () => location.reload());
}

function showError(err) {
  console.error(err);
  mount(main, h('section', { class: 'screen boot error' },
    h('h2', null, 'Something went wrong'),
    h('p', null, `The simulator could not load (${err?.message || err}). Check your connection and reload; your game picks up where you left off.`),
    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, 'Reload')));
}

async function boot() {
  const app = {
    main,
    lib: null,
    setSub: (...nodes) => mount(sub, ...nodes),
  };
  installKeys();
  setupHeader(app);
  try {
    app.lib = await loadLibrary('data/');
  } catch (err) {
    showError(err);
    return;
  }
  if (!helpSeen()) {
    markHelpSeen();
    openHelp({ first: true });
  }
  try {
    await (mode === 'survivor' ? runSurvivor(app) : runDaily(app));
  } catch (err) {
    showError(err);
  }
}

boot();
