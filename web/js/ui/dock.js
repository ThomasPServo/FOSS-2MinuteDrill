// The dock's prompts: offensive call menus (family → call, tempo, timeout, clock options),
// defensive calls, tries, kickoffs and kick defense. ask() renders a prompt and resolves
// with the user's choice: { action, tempo?, timeout?, oob?, call? }.

import { h } from './dom.js';
import { icon } from './icons.js';
import { bind } from './keys.js';
import { pct } from './format.js';

const FAMILIES = [
  { id: 'run', label: 'Run', sub: 'Hand it off or keep it' },
  { id: 'pass', label: 'Pass', sub: 'Drop back and throw' },
  { id: 'rpo', label: 'RPO', sub: 'The QB reads it at the line' },
  { id: 'trick', label: 'Trick', sub: "Something they haven't seen" },
];
const DEFENSE = {
  base: ['Base', 'Play it straight'],
  blitz: ['Blitz', 'Send extra rushers'],
  load: ['Load the box', 'Stop the run'],
  soft: ['Play it soft', 'Keep everything in front'],
};
const KICK_DEFENSE = {
  block: 'All-out rush. A roughing flag gives them a first down',
  home: 'Normal rush, no risk',
  ice: 'Call a timeout first',
};
const DIR_KEY = { left: '← Left', middle: 'Middle', right: 'Right →' };
const DIR_ORDER = { left: 0, middle: 1, right: 2 };

const freqText = (f) => (f == null ? null : f >= 0.005 ? `NFL ${pct(f)}` : 'NFL rare');
const avgText = (a) => (a == null ? null : `${a >= 0 ? '' : '−'}${Math.abs(a).toFixed(1)} yds`);

/** A big menu key: title, sub-label, optional meta line and a digit hint. */
function key({ label, sub, meta, hot, cls, onClick }) {
  return h('button', { class: ['key', cls], type: 'button', onclick: onClick },
    h('span', { class: 'key-top' }, h('span', { class: 'key-label' }, label), hot ? h('kbd', { class: 'kbd' }, hot) : null),
    sub ? h('span', { class: 'key-sub' }, sub) : null,
    meta ? h('span', { class: 'key-meta' }, meta) : null);
}

function toggle(label, sub, on, onChange) {
  const btn = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on) },
    h('span', { class: 'track', 'aria-hidden': 'true' }),
    h('span', { class: 'txt' }, h('b', null, label), sub ? h('small', null, sub) : null));
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return btn;
}

function head(title, situation, extra) {
  return h('header', { class: 'prompt-head' }, h('h2', null, title), situation ? h('span', { class: 'prompt-sit' }, situation) : null, extra || null);
}

/** Group calls into rows by their base play, with one key per direction. */
function callRows(calls) {
  const rows = new Map();
  for (const c of calls) {
    const base = c.dir ? c.label.replace(/\s+(left|right|middle)$/i, '') : c.label;
    if (!rows.has(base)) rows.set(base, []);
    rows.get(base).push(c);
  }
  return [...rows].map(([base, list]) => ({ base, list: list.sort((a, b) => (DIR_ORDER[a.dir] ?? 1) - (DIR_ORDER[b.dir] ?? 1)) }));
}

/**
 * Keep keyboard users in the dock: when the focused button was replaced by a new prompt,
 * focus moves to the prompt's first key (without scrolling the page).
 */
export function keepFocus(slot) {
  const a = document.activeElement;
  if (!a || a === document.body || !a.isConnected || slot.contains(a)) {
    slot.querySelector('.key:not([disabled]), .alt, .back, .btn')?.focus({ preventScroll: true });
  }
}

/** Show a prompt for decision `dec` in `slot`; resolves with the choice. */
export function ask(slot, dec, ctx) {
  return new Promise((resolve) => {
    const done = (choice) => {
      bind({});
      slot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      resolve(choice);
    };
    if (dec.kind === 'offense') offense(slot, dec, ctx, done);
    else if (dec.kind === 'defense') defense(slot, dec, ctx, done);
    else if (dec.kind === 'pat') tryPrompt(slot, dec, ctx, done);
    else simple(slot, dec, ctx, done);
  });
}

// --- offense --------------------------------------------------------------------------------------

function offense(slot, dec, ctx, done) {
  const st = { step: 'family', tempo: dec.tempo?.default ?? null, timeout: false, oob: false };
  const sit = ctx.situation;

  const two = dec.kind === 'two';

  /** Odds line of a call: average gain, or the conversion rate on a two-point try. */
  const odds = (c) => (two ? (c.conv != null ? `${pct(c.conv)} convert` : null) : avgText(c.avg));

  function famMeta(id) {
    const calls = dec.calls.filter((c) => c.family === id);
    const f = calls.reduce((a, c) => a + (c.freq || 0), 0);
    if (!(f > 0)) return freqText(f);
    const mean = (k) => calls.reduce((a, c) => a + (c.freq || 0) * (c[k] ?? 0), 0) / f;
    return [freqText(f), two ? `${pct(mean('conv'))} convert` : avgText(mean('avg'))].join(' · ');
  }

  function choose(action) {
    done({ action, tempo: st.timeout ? null : st.tempo, timeout: st.timeout, oob: st.oob && action.type === 'play' });
  }

  function changed() {
    ctx.onSettings?.({ tempo: st.timeout ? null : st.tempo, timeout: st.timeout, oob: st.oob });
  }

  function lookLine() {
    if (!dec.look) return null;
    return h('div', { class: ['read', `look-${dec.look.id}`] },
      h('span', { class: 'read-tag' }, 'Defense shows'),
      h('b', null, dec.look.label), h('span', { class: 'read-note' }, dec.look.note));
  }

  function tempoPicker() {
    if (!dec.tempo || st.timeout) return null;
    const group = h('div', { class: 'tempo', role: 'radiogroup', 'aria-label': 'Tempo' });
    for (const t of dec.tempo.choices) {
      const on = t.id === st.tempo;
      group.append(h('button', {
        class: 'tempo-opt', type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1',
        onclick: () => { st.tempo = t.id; changed(); render(); slot.querySelector('.tempo [aria-checked="true"]')?.focus(); },
        onkeydown: (e) => {
          const list = dec.tempo.choices;
          const i = list.findIndex((x) => x.id === st.tempo);
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          st.tempo = list[(i + d + list.length) % list.length].id;
          changed();
          render();
          slot.querySelector('.tempo [aria-checked="true"]')?.focus();
        },
      }, h('b', null, t.label), h('small', null, t.sub)));
    }
    return h('div', { class: 'tempo-wrap' }, h('span', { class: 'mini-label' }, 'Clock is running · tempo'), group);
  }

  function altKeys(hotStart) {
    const keys = [];
    const hot = (b) => { if (hotStart <= 9) ctx.hot[String(hotStart)] = b; hotStart += 1; return b; };
    if (dec.canTimeout) {
      keys.push(hot(h('button', {
        class: ['alt', st.timeout && 'on'], type: 'button', 'aria-pressed': String(st.timeout),
        onclick: () => { st.timeout = !st.timeout; changed(); render(); },
      }, h('b', null, st.timeout ? 'Timeout called' : 'Timeout'), h('small', null, st.timeout ? 'Tap to undo' : `${dec.timeouts} left`), hint(hotStart - 1))));
    }
    for (const a of dec.alts) {
      if (st.timeout && (a.id === 'spike' || a.id === 'rundown')) continue;
      const fgOdds = [a.dist && `${a.dist} yds`, a.p != null && `${pct(a.p)} to make`, a.rushed && 'rushed'].filter(Boolean).join(' · ');
      const sub = { fg: fgOdds, rundown: 'Timeout at 0:03, then kick', spike: 'Stop the clock', kneel: 'Run the clock', punt: 'Flip the field' }[a.id] || '';
      const label = { fg: 'Field goal', rundown: 'Run it down', spike: 'Spike it', kneel: 'Kneel', punt: 'Punt' }[a.id] || a.label;
      keys.push(hot(h('button', { class: 'alt', type: 'button', onclick: () => choose(a.action) },
        h('b', null, label), sub ? h('small', null, sub) : null, hint(hotStart - 1))));
    }
    return keys.length ? h('div', { class: 'alts' }, keys) : null;
  }

  function familyStep() {
    const fams = FAMILIES.filter((f) => dec.calls.some((c) => c.family === f.id));
    ctx.hot = {};
    const keys = fams.map((f, i) => {
      const b = key({ label: f.label, sub: f.sub, meta: famMeta(f.id), hot: String(i + 1), cls: `fam fam-${f.id}`, onClick: () => { st.step = f.id; render(); } });
      ctx.hot[String(i + 1)] = b;
      return b;
    });
    return [
      head('Your call', sit, st.timeout ? h('span', { class: 'pill-stop' }, 'Clock stopped') : null),
      lookLine(),
      tempoPicker(),
      h('div', { class: 'families' }, keys),
      altKeys(fams.length + 1),
    ];
  }

  function detailStep(fam) {
    const famInfo = FAMILIES.find((f) => f.id === fam);
    const calls = dec.calls.filter((c) => c.family === fam);
    ctx.hot = {};
    let n = 0;
    const back = h('button', { class: 'back', type: 'button', onclick: () => { st.step = 'family'; render(); } }, icon('back'), 'Back');
    ctx.hot.back = back;
    const rows = callRows(calls).map(({ base, list }) => {
      const multi = list.length > 1;
      return h('div', { class: ['call-row', multi && 'multi'] },
        multi ? h('span', { class: 'row-label' }, base) : null,
        h('div', { class: 'row-keys' }, list.map((c) => {
          n += 1;
          const meta = [freqText(c.freq), odds(c)].filter(Boolean).join(' · ');
          const b = key({
            label: multi ? DIR_KEY[c.dir] || c.label : c.label,
            meta, hot: n <= 9 ? String(n) : null, cls: 'call', onClick: () => choose(c.action),
          });
          b.setAttribute('aria-label', `${c.label}. ${meta}`);
          if (n <= 9) ctx.hot[String(n)] = b;
          return b;
        })));
    });
    const tempoTag = st.timeout ? 'after a timeout' : st.tempo ? dec.tempo?.choices.find((t) => t.id === st.tempo)?.label : null;
    return [
      head(famInfo.label, sit, h('span', { class: 'head-tools' }, tempoTag ? h('span', { class: 'chip' }, tempoTag) : null, back)),
      lookLine(),
      h('div', { class: 'calls' }, rows),
      dec.canOob
        ? toggle('Get out of bounds', 'The ball carrier tries to stop the clock. No guarantee.', st.oob, (v) => { st.oob = v; changed(); })
        : null,
    ];
  }

  function render() {
    slot.replaceChildren(h('section', { class: 'prompt', 'aria-label': two ? 'Two-point try' : 'Your call' },
      st.step === 'family' ? familyStep() : detailStep(st.step)));
    bind(ctx.hot);
    keepFocus(slot);
  }
  render();
}

function hint(n) {
  return n <= 9 ? h('kbd', { class: 'kbd' }, String(n)) : null;
}

// --- defense --------------------------------------------------------------------------------------

function defense(slot, dec, ctx, done) {
  let timeout = false;
  const hot = {};
  const keys = dec.options.map((o, i) => {
    const [label, sub] = DEFENSE[o.id] || [o.label, ''];
    const b = key({
      label, sub, meta: freqText(o.freq), hot: String(i + 1), cls: `def def-${o.id}`,
      onClick: () => done({ action: o.action, timeout }),
    });
    hot[String(i + 1)] = b;
    return b;
  });
  const coordinator = h('button', {
    class: 'chip coord', type: 'button',
    onclick: () => { ctx.setCoordinator(true); done({ action: ctx.coordinatorAction(dec), timeout: false, coordinator: true }); },
  }, icon('forward'), 'Let the coordinator call this drive');
  slot.replaceChildren(h('section', { class: 'prompt', 'aria-label': 'Your defense' },
    head('Your defense', ctx.situation),
    h('div', { class: 'families def-keys' }, keys),
    dec.canTimeout ? toggle('Timeout first', `Stop the clock before their snap · ${dec.timeouts} left`, false, (v) => { timeout = v; ctx.onSettings?.({ timeout: v }); }) : null,
    h('div', { class: 'prompt-foot' }, coordinator)));
  bind(hot);
  keepFocus(slot);
}

// --- tries ----------------------------------------------------------------------------------------

function tryPrompt(slot, dec, ctx, done) {
  const hot = {};
  const keys = dec.options.map((o, i) => {
    const two = o.id === 'two';
    const b = key({
      label: two ? 'Go for two' : 'Kick it', sub: two ? 'Run a play from the 2' : 'Extra point from the 15',
      meta: o.p != null ? `${pct(o.p)} ${two ? 'convert' : 'make it'}` : null, hot: String(i + 1), cls: `try try-${o.id}`,
      onClick: () => (two ? twoCall() : done({ action: o.action })),
    });
    hot[String(i + 1)] = b;
    return b;
  });
  slot.replaceChildren(h('section', { class: 'prompt', 'aria-label': 'Try after the touchdown' },
    head('Touchdown! Kick it or go for two?', ctx.situation), h('div', { class: 'families two-up' }, keys)));
  bind(hot);
  keepFocus(slot);

  function twoCall() {
    const menu = { kind: 'two', calls: dec.twoCalls, alts: [], tempo: null, look: null, canTimeout: false, canOob: false };
    offense(slot, menu, { ...ctx, situation: 'Two-point try from the 2' }, done);
  }
}

// --- kickoffs and kick defense ------------------------------------------------------------------------

function simple(slot, dec, ctx, done) {
  const hot = {};
  let title;
  if (dec.kind === 'kickoff') title = 'Kickoff: where do you kick it?';
  else title = dec.what === 'punt' ? "They're punting" : `They're kicking a field goal${dec.dist ? ` (about ${dec.dist} yards)` : ''}`;
  const keys = dec.options.map((o, i) => {
    let label = o.label;
    let sub = '';
    if (dec.kind === 'kickoff') {
      label = o.id === 'onside' ? 'Onside kick' : 'Kick it deep';
      sub = o.id === 'onside' ? 'Try to get it back' : 'Make them go the length of the field';
    } else {
      if (o.id === 'block') label = dec.what === 'punt' ? 'Rush the punt' : 'Go for the block';
      if (o.id === 'home') label = dec.what === 'punt' ? 'Set up the return' : 'Stay home';
      if (o.id === 'ice') label = 'Ice the kicker';
      sub = KICK_DEFENSE[o.id] || '';
    }
    const b = key({ label, sub, meta: o.p != null ? `${pct(o.p)} success` : null, hot: String(i + 1), cls: `st st-${o.id}`, onClick: () => done({ action: o.action }) });
    hot[String(i + 1)] = b;
    return b;
  });
  const sit = dec.what === 'fg' && dec.p != null ? `${ctx.situation} · ${pct(dec.p)} to make` : ctx.situation;
  slot.replaceChildren(h('section', { class: 'prompt', 'aria-label': title }, head(title, sit), h('div', { class: 'families' }, keys)));
  bind(hot);
  keepFocus(slot);
}
