// The field view for one game: scoreboard, field, dock and play-by-play. GameView.run()
// loops decision → prompt → snap → animation → result until the final whistle and resolves
// with the session's summary.

import { announce, h, mount, sleep } from './dom.js';
import { choreograph } from './choreo.js';
import { ask, keepFocus } from './dock.js';
import { Field } from './field.js';
import { FIELD_W, spotBall } from './formation.js';
import { icon } from './icons.js';
import { bind } from './keys.js';
import { PlayByPlay } from './pbp.js';
import { announceText, resultCard } from './result.js';
import { buildScene } from './scene.js';
import { Scoreboard } from './scoreboard.js';

const hash = (str) => [...str].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export class GameView {
  /**
   * @param root     element to render the screen into
   * @param session  Session (session.js)
   * @param saved    snapshot from a previous save() to resume from, or null
   * @param save     called with a snapshot after every snap
   */
  constructor(root, session, { saved = null, save = () => {} } = {}) {
    this.session = session;
    this.save = save;
    const view = session.view();
    this.teams = view.teams;
    this.ballX = saved?.ballX ?? FIELD_W / 2;
    this.coordinator = saved?.coordinator ?? false;
    this.last = saved?.last ?? null;
    this.skipping = false;
    this.replay = null;
    this.replaying = null;
    this.scoreboard = new Scoreboard();
    this.resultSlot = h('div', { class: 'dock-result' });
    this.promptSlot = h('div', { class: 'dock-prompt' });
    this.pbp = new PlayByPlay(saved?.log ?? []);
    const fieldHost = h('div', { class: 'field-host' });
    this.panel = h('div', { class: 'panel' }, h('div', { class: 'dock' }, this.resultSlot, this.promptSlot), this.pbp.el);
    this.el = h('section', { class: 'screen game' }, this.scoreboard.el, fieldHost, this.panel);
    mount(root, this.el);
    this.field = new Field(fieldHost, { teams: this.teams, me: view.me });
  }

  get me() {
    return this.session.me;
  }

  snapshot() {
    return {
      game: this.session.toJSON(), log: this.pbp.lines, last: this.last, ballX: this.ballX, coordinator: this.coordinator,
    };
  }

  async run() {
    if (this.last) this.resultSlot.replaceChildren(resultCard(this.last));
    let previousWasMine = false;
    for (;;) {
      const dec = this.session.decision();
      const view = this.session.view();
      if (view.userHasBall) this.coordinator = false;
      this.scoreboard.render(view);
      if (dec.kind === 'done') break;
      await this.field.show(this.sceneFor(view, dec), { label: this.fieldLabel(view) });
      const auto = dec.kind === 'auto' || (dec.kind === 'defense' && this.coordinator && !dec.canTimeout && !dec.quiet);
      if (auto) {
        if (previousWasMine && !this.skipping) await this.waitContinue();
        await this.autoSnap(dec);
        previousWasMine = false;
        continue;
      }
      this.skipping = false;
      this.session.prefetch(dec);
      const choice = dec.kind === 'defense' && (this.coordinator || dec.quiet)
        ? await this.coordinatorTimeout(dec, view)
        : await ask(this.promptSlot, dec, this.askContext(view, dec));
      if (choice.coordinator) this.coordinator = true;
      await this.snap(choice, dec);
      previousWasMine = true;
    }
    bind({});
    this.promptSlot.replaceChildren();
    return this.session.summary();
  }

  askContext(view, dec) {
    return {
      situation: view.situation,
      setCoordinator: (on) => { this.coordinator = on; },
      coordinatorAction: (d) => this.session.coordinatorAction(d),
      // regrade in the background when the tempo / timeout / out-of-bounds settings change
      onSettings: (settings) => this.session.prefetch(dec, settings),
      hot: {},
    };
  }

  // --- scenes -------------------------------------------------------------------------------------

  sceneFor(view, dec, type = null, look = null) {
    let t = type;
    if (!t) {
      if (view.phase === 'kickoff') t = 'kickoff';
      else if (view.phase === 'pat') t = 'xp';
      else if (dec?.kind === 'kick_defense') t = dec.what === 'punt' ? 'punt' : 'fg';
      else t = view.ytg <= 1 ? 'under' : 'snap';
    }
    if (t === 'kickoff' || t === 'xp') this.ballX = FIELD_W / 2;
    const lookId = look || dec?.look?.id || 'base';
    const strong = (Math.round(view.clock) + view.down + Math.round(view.yl)) % 2 ? 1 : -1;
    return buildScene({
      view, lineups: [this.session.lineup(0), this.session.lineup(1)], type: t, look: lookId, strong, ballX: this.ballX,
    });
  }

  fieldLabel(view) {
    const off = view.teams[view.offense];
    return `Field. ${view.situation}. ${off.name} ${view.phase === 'kickoff' ? 'kicking off' : 'with the ball'}. Your end zone is at the bottom.`;
  }

  // --- snaps --------------------------------------------------------------------------------------

  async snap(choice, dec, { auto = false } = {}) {
    // a new snap cuts any replay short
    this.field.skip();
    await this.replaying;
    this.resultSlot.firstElementChild?.classList.add('stale');
    this.promptSlot.replaceChildren(h('div', { class: 'status snapping' },
      h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('b', null, auto ? this.autoStatus() : 'Snap…'),
      h('small', null, 'Tap the field to skip'), auto && !this.skipping ? this.skipChip() : null));
    bind({});
    const r = await this.session.act(choice);
    await this.animate(r, dec, choice, r.runoff);
    this.scoreboard.render(r.after);
    for (const line of r.lines) this.pbp.add(line);
    this.last = r;
    const replay = this.replay;
    this.resultSlot.replaceChildren(resultCard(r, { onReplay: replay ? () => this.playReplay(replay) : null }));
    announce(announceText(r));
    this.save(this.snapshot());
  }

  async animate(r, dec, choice, runoff) {
    this.replay = null;
    const anim = r.main?.anim;
    if (this.skipping || !anim) {
      if (r.after.phase !== 'snap') this.ballX = FIELD_W / 2;
      return;
    }
    const sceneType = {
      fg: 'fg', xp: 'xp', punt: 'punt', kickoff: 'kickoff', two: 'two', spike: 'under', kneel: 'under',
    }[anim.type] || (anim.call === 'qb_sneak' || r.before.ytg <= 1 ? 'under' : 'snap');
    const look = choice.action?.look || dec.look?.id || null;
    const scene = this.sceneFor(r.before, dec, sceneType, look);
    await this.field.show(scene);
    if (runoff >= 1) {
      // the clock burns before the snap
      const from = r.before.clock;
      const ms = Math.max(550, Math.min(1500, 400 + (runoff / 30) * 1000));
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        this.scoreboard.setClock(from - (runoff * (performance.now() - t0)) / ms, 'runoff');
        await sleep(40);
      }
    }
    const clockAtSnap = r.main.clockBefore ?? r.before.clock - runoff;
    const ch = choreograph({ anim, scene, after: r.after, seed: hash(`${r.main.text}|${clockAtSnap}`) });
    const sameQuarter = r.after.quarter === r.before.quarter;
    const end = sameQuarter ? r.after.clock : 0;
    await this.field.play(ch, { onTick: (k) => this.scoreboard.setClock(clockAtSnap + (end - clockAtSnap) * k, 'running') });
    this.replay = { scene, ch };
    if (r.after.phase !== 'snap') this.ballX = FIELD_W / 2;
    else if (ch.end) this.ballX = spotBall(ch.end[0]);
  }

  playReplay({ scene, ch }) {
    if (this.replaying || this.field.playing) return;
    const now = this.field.scene;
    this.replaying = (async () => {
      await this.field.show(scene, { animate: false });
      await this.field.play(ch);
      if (now) await this.field.show(now);
      this.replaying = null;
    })();
  }

  /** "Skip ahead": no more animation for the rest of this run of automatic plays. */
  skipChip() {
    const chip = h('button', { class: 'chip', type: 'button', onclick: () => { this.skipping = true; this.field.skip(); chip.remove(); } },
      icon('forward'), 'Skip ahead');
    return chip;
  }

  autoStatus() {
    const view = this.session.view();
    const opp = view.teams[1 - this.me].name;
    if (view.phase === 'kickoff') return view.offense === this.me ? 'You kick off' : `The ${opp} kick off`;
    if (view.phase === 'pat') return view.offense === this.me ? 'Your try' : `The ${opp} try the extra point`;
    return view.userHasBall ? 'Your ball' : `The ${opp} have the ball`;
  }

  async autoSnap(dec) {
    const lastLine = this.pbp.lines[this.pbp.lines.length - 1];
    this.promptSlot.replaceChildren(h('div', { class: 'status auto' },
      h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('b', null, this.autoStatus()),
      lastLine ? h('small', null, lastLine.text) : null, this.skipping ? null : this.skipChip()));
    await sleep(this.skipping ? 60 : 700);
    const action = dec.kind === 'defense' ? this.session.coordinatorAction(dec) : { type: 'auto' };
    await this.snap({ action }, dec, { auto: true });
  }

  /** With the coordinator calling the defense, the only question is the clock. */
  coordinatorTimeout(dec, view) {
    return new Promise((resolve) => {
      const go = (timeout) => resolve({ action: this.session.coordinatorAction(dec), timeout });
      const t = h('button', { class: 'key', type: 'button', onclick: () => go(true) },
        h('span', { class: 'key-top' }, h('span', { class: 'key-label' }, 'Timeout'), h('kbd', { class: 'kbd' }, '1')),
        h('span', { class: 'key-sub' }, `${dec.timeouts} left`));
      const l = h('button', { class: 'key', type: 'button', onclick: () => go(false) },
        h('span', { class: 'key-top' }, h('span', { class: 'key-label' }, 'Let it run'), h('kbd', { class: 'kbd' }, '2')),
        h('span', { class: 'key-sub' }, dec.quiet ? 'Let them have it' : 'Your coordinator has the call'));
      const title = dec.quiet ? `They're lining up to ${dec.quiet}` : 'Clock is running';
      this.promptSlot.replaceChildren(h('section', { class: 'prompt', 'aria-label': title },
        h('header', { class: 'prompt-head' }, h('h2', null, title), h('span', { class: 'prompt-sit' }, view.situation)),
        dec.canTimeout ? h('div', { class: 'families two-up' }, t, l) : h('div', { class: 'families' }, l)));
      bind({ 1: t, 2: l });
      keepFocus(this.promptSlot);
    });
  }

  /** After your play, wait for a tap before the opponent's plays run. */
  waitContinue() {
    return new Promise((resolve) => {
      const btn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => resolve() }, 'Next play', h('kbd', { class: 'kbd' }, '↵'));
      this.promptSlot.replaceChildren(btn);
      bind({ primary: btn });
      keepFocus(this.promptSlot);
    });
  }

  /** Put the end-of-game card in the dock. */
  showEnd(card) {
    this.promptSlot.replaceChildren(card);
    card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}
