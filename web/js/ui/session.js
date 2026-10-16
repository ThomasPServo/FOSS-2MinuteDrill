// The one adapter between the UI and the engine (web/js/engine, docs/ENGINE.md). Everything
// the UI shows about a game comes through here as plain "view" objects, so engine API
// changes are fixed in this file only.

import { Engine } from '../engine/index.js';
import { ballOn, clock as fmtClock, daysBetween, downDistance } from './format.js';
import { team as teamInfo } from './teams.js';

const LOOKS = {
  base: { id: 'base', label: 'Base defense', note: '7 in the box' },
  blitz: { id: 'blitz', label: 'Showing blitz', note: 'extra rushers' },
  load: { id: 'load', label: 'Loaded box', note: '8 or more near the line' },
  soft: { id: 'soft', label: 'Light box', note: '6 or fewer near the line' },
};
const TEMPO_TEXT = {
  hurry: { label: 'No-huddle', sub: 'Snap it fast' },
  normal: { label: 'Huddle', sub: 'Normal pace' },
  milk: { label: 'Milk it', sub: 'Burn the play clock' },
};
const MARKS = { green: 'g', yellow: 'y', orange: 'o', red: 'r' };
const GRADE_WORDS = { g: 'Good call', y: 'Close', o: 'Costly', r: 'Big miss' };
const SYMBOLS = { g: '✓', y: '≈', o: '!', r: '✗' };
const RESULTS = { win: 'W', loss: 'L', tie: 'T', half: 'HT' };
const TARGET = { QB: 0, RB: 1, WR: 2, TE: 3 };
const FL_SAFETY = 256;   // DATA.md plays.json flag bit 8

/** Grade mark from points of win chance lost (same bands as the engine's GRADES). */
export function markFor(lost) {
  if (lost <= 0.5) return 'g';
  if (lost <= 2) return 'y';
  if (lost <= 5) return 'o';
  return 'r';
}
export const symbolOf = (mark) => SYMBOLS[mark];

/** Load the engine and its index once; returns a Library. */
export async function loadLibrary(base = 'data/') {
  return new Library(await Engine.load(base));
}

class Library {
  constructor(eng) {
    this.eng = eng;
    this.index = eng.spotIndex;
    this.byId = new Map((this.index.spots || []).map((s) => [s.id, s]));
  }

  /** Day number (1 = launch day) for a local YYYY-MM-DD date. */
  dayNumber(date) {
    return Math.max(1, daysBetween(this.index.launch, date) + 1);
  }

  /** The daily spot for the player's local date. */
  dailySpotId(date) {
    return this.eng.dailySpotId(date);
  }

  survivorPool() {
    return this.eng.survivorSpotIds();
  }

  categoryLabel(cat, qtr) {
    if (cat === 'tight') return qtr === 2 ? 'End of the half' : 'Tied game';
    return this.index.categories?.[cat] || 'Late game';
  }

  loadSpot(id) {
    return this.eng.loadSpot(id);
  }

  /** Start a game. Daily games use the engine's default seed (the same for every player). */
  start(spot, { mode, seed, tendencies }) {
    return new Session(this, spot, this.eng.newGame(spot, { mode, seed, tendencies }));
  }

  /** Resume a saved game (Session#toJSON output). */
  async resume(spot, saved) {
    return new Session(this, spot, await Engine.restore(this.eng, saved, spot));
  }

  call(id) {
    return this.eng.calls.find((c) => c.id === id) || null;
  }

  /** Look-alike coach for measures accumulated over many games. */
  lookalike(measures) {
    return lookalikeView(this.eng.lookalike(measures));
  }

  addMeasures(a, b) {
    return this.eng.addMeasures(a, b);
  }
}

function lookalikeView(l) {
  if (!l?.coach) return null;
  const c = l.coach;
  return { name: c.name, teams: c.teams || [], from: c.from, to: c.to, reasons: (l.reasons || []).map((r) => r.text) };
}

class Session {
  constructor(lib, spot, game) {
    this.lib = lib;
    this.spot = spot;
    this.game = game;
  }

  get state() {
    return this.game.state;
  }

  /** Team index (0 home, 1 away) the player coaches. */
  get me() {
    return this.state.user;
  }

  /** The user's recent call ids (the defense adapts to them; carried across survivor games). */
  get tendencies() {
    return this.game.tend || [];
  }

  toJSON() {
    return this.game.toJSON();
  }

  /** Lineups for team index i: { off, def, k, p } (players {name, short, pos, num, r, spd}). */
  lineup(i) {
    const p = this.spot.players?.[this.state.teams[i]] || {};
    return { off: p.off || [], def: p.def || [], k: p.k || null, p: p.p || null };
  }

  /** Spot facts for the scenario card and the end card. */
  facts() {
    const sp = this.spot;
    const mine = sp.team;
    const opp = sp.team === sp.home ? sp.away : sp.home;
    return {
      id: sp.id,
      category: this.lib.categoryLabel(sp.cat, sp.start.qtr),
      season: sp.season, week: sp.week, type: sp.type,
      mine, opp,
      startScore: { mine: sp.start.score[mine], opp: sp.start.score[opp] },
      coach: sp.real?.coach?.[mine] || null,
      realCall: this.lib.call(sp.real?.call)?.label || null,
    };
  }

  // --- situation view -------------------------------------------------------------------------

  /** Everything the scoreboard, the down line and the field need, from a state. */
  view(state = this.state) {
    const me = state.user;
    const done = state.phase === 'done';
    const ot = state.qtr >= 5;
    const kicking = state.phase === 'kickoff';
    const offense = kicking ? state.kicker : state.pos;
    const userHasBall = state.pos === me;
    const half = done && state.endAtHalf && state.winner === null;
    let quarter = ot ? (state.qtr > 5 ? `OT${state.qtr - 4}` : 'OT') : `Q${state.qtr}`;
    if (done) quarter = half ? 'HALF' : ot ? 'FINAL/OT' : 'FINAL';
    // L = yards from the user's goal line (0) to the opponent's (100)
    let los = null;
    let ltg = null;
    if (state.phase === 'snap' || state.phase === 'pat') {
      los = userHasBall ? 100 - state.yl : state.yl;
      if (state.phase === 'snap' && state.ytg < state.yl) ltg = userHasBall ? los + state.ytg : los - state.ytg;
    } else if (kicking) {
      los = state.kicker === me ? 35 : 65;
    }
    let situation;
    if (done) situation = half ? 'Halftime' : 'Final';
    else if (state.phase === 'pat') situation = userHasBall ? 'Your try after the touchdown' : 'Their try after the touchdown';
    else if (kicking) situation = `${state.free ? 'Free kick' : 'Kickoff'} · ${state.kicker === me ? 'you kick' : 'you receive'}`;
    else situation = `${downDistance(state.down, state.ytg, state.yl)} · ball on ${ballOn(state.yl, userHasBall)}`;
    return {
      me,
      teams: [0, 1].map((i) => ({
        ...teamInfo(state.teams[i]), index: i, score: state.score[i], timeouts: state.to[i], isMe: i === me,
        hasBall: !done && offense === i && !kicking,
      })),
      quarter, clock: state.clock, clockText: fmtClock(state.clock), running: Boolean(state.running) && !done,
      phase: state.phase, done, userHasBall, offense, offenseUp: offense === me,
      down: state.down, ytg: state.ytg, yl: state.yl, los, ltg, situation,
      margin: state.score[me] - state.score[1 - me],
    };
  }

  // --- decisions ------------------------------------------------------------------------------

  /** The current decision, normalised for the dock. */
  decision() {
    const d = this.game.decision();
    const base = { kind: d.kind, raw: d, prompt: d.prompt };
    switch (d.kind) {
      case 'offense': return { ...base, ...this.offenseMenu(d) };
      case 'defense':
        return {
          ...base,
          quiet: d.offense === 'kneel' || d.offense === 'spike' ? d.offense : null,
          canTimeout: Boolean(d.timeout?.available),
          timeouts: d.timeout?.left ?? 0,
          options: d.options.map((o) => ({ id: o.look, label: o.label, action: o, freq: o.nfl?.freq ?? null })),
        };
      case 'pat': {
        const xp = d.options.find((o) => o.kind === 'xp');
        const twos = d.options.filter((o) => o.kind === 'two');
        const f = twos.reduce((a, o) => a + (o.nfl?.freq || 0), 0);
        const conv = f > 0 ? twos.reduce((a, o) => a + (o.nfl?.freq || 0) * (o.nfl?.conv || 0), 0) / f : null;
        return {
          ...base,
          options: [
            { id: 'xp', label: xp.label, p: xp.p ?? null, action: xp },
            { id: 'two', label: 'Go for two', p: conv, action: null },
          ],
          twoCalls: twos.map((o) => {
            const meta = this.lib.call(o.call) || {};
            return {
              id: o.call, label: meta.label || o.label, family: o.family || meta.family, dir: meta.dir ?? null,
              freq: o.nfl?.freq ?? null, conv: o.nfl?.conv ?? null, action: o,
            };
          }),
        };
      }
      case 'kickoff':
        return { ...base, options: d.options.map((o) => ({ id: o.id, label: o.label, p: o.p ?? null, action: o })) };
      case 'kick_defense': {
        const options = d.options.map((o) => ({ id: o.block ? 'block' : 'home', label: o.label, action: o }));
        if (d.kick === 'fg' && d.timeout?.available) {
          const safe = d.options.find((o) => !o.block);
          options.push({ id: 'ice', label: 'Ice the kicker', action: { ...safe, timeout: true } });
        }
        return { ...base, what: d.kick, dist: d.fg?.dist ?? null, p: d.fg?.p ?? null, options };
      }
      default:
        return base;
    }
  }

  offenseMenu(d) {
    const calls = [];
    const alts = [];
    for (const o of d.options) {
      if (o.type === 'play') {
        calls.push({
          id: o.call, label: o.label, family: o.family, kind: o.kind, dir: o.dir ?? null, depth: o.depth ?? null,
          freq: o.nfl?.freq ?? null, avg: o.nfl?.avg ?? null, conv: o.nfl?.conv ?? null, action: o,
        });
      } else {
        alts.push({
          id: o.id, label: o.label, action: o,
          dist: o.fg?.dist ?? null, p: o.fg ? (o.fg.rushed ?? o.fg.p) : null, rushed: o.fg?.rushed != null,
        });
      }
    }
    return {
      look: LOOKS[d.look] || null,
      running: Boolean(d.state.running),
      timeouts: d.timeout?.left ?? 0,
      canTimeout: Boolean(d.timeout?.available),
      canOob: Boolean(d.oob?.available),
      tempo: d.tempo ? { default: d.tempo.default, choices: d.tempo.choices.map((id) => ({ id, ...TEMPO_TEXT[id] })) } : null,
      calls, alts,
    };
  }

  /** The action that lets the defensive coordinator call a snap (the base look). */
  coordinatorAction(dec) {
    return (dec.options.find((o) => o.id === 'base') || dec.options[0]).action;
  }

  /** Start grading in the background; call again when the clock settings change. */
  prefetch(dec, settings) {
    this.game.prefetch(dec.raw, settings).catch(() => {});
  }

  /**
   * Play a choice { action, tempo?, timeout?, oob? } where `action` is an option's engine
   * action. Returns a normalised result.
   */
  async act(choice) {
    const action = { ...choice.action };
    if (choice.tempo) action.tempo = choice.tempo;
    if (choice.timeout) action.timeout = true;
    if (choice.oob) action.oob = true;
    const beforeState = this.state;
    const before = this.view(beforeState);
    const r = await this.game.act(action);
    const after = this.view(r.state);
    const entries = r.log.map((e) => this.entry(e));
    const main = [...entries].reverse().find((e) => e.anim) || entries[entries.length - 1] || null;
    return {
      entries, main, before, after,
      lines: entries.flatMap((e) => e.lines),
      runoff: entries.reduce((a, e) => a + e.runoff, 0),
      grade: r.grade ? gradeView(r.grade) : null,
      wpBefore: r.wpBefore ?? null, wpAfter: r.wpAfter ?? null,
      headline: main?.headline || '',
    };
  }

  /** One engine log entry: text lines for the play-by-play and animation facts. */
  entry(e) {
    const me = this.me;
    const mine = e.team === me;
    const pre = (e.pre || []).filter((p) => p.text);
    const lines = [
      ...pre.map((p) => ({ text: p.text, mine: p.team === me, clock: p.clock ?? e.clockBefore, qtr: p.qtr ?? e.qtr })),
      ...(e.text ? [{ text: e.text, mine, clock: e.clockAfter, qtr: e.qtrAfter }] : []),
      ...(e.post || []).map((t) => ({ text: t, mine: false, clock: e.clockAfter, qtr: e.qtrAfter })),
    ];
    const r = e.real;
    return {
      kind: e.type, team: e.team, mine, text: e.text, headline: e.headline || '', lines,
      runoff: (e.pre || []).filter((p) => p.type === 'runoff').reduce((a, p) => a + (p.secs || 0), 0),
      clockBefore: e.clockBefore,
      provenance: r?.season ? `${r.season} W${r.week} ${r.away} @ ${r.home}` : null,
      anim: this.anim(e),
    };
  }

  /** Map the engine's animation facts onto the choreographer's vocabulary. */
  anim(e) {
    const a = e.anim;
    if (!a) return null;
    const meta = this.lib.call(e.call) || {};
    switch (a.kind) {
      case 'run':
      case 'pass':
      case 'sack':
      case 'scramble':
      case 'penalty': {
        if (e.type === 'two') {
          return { type: 'two', kind: a.kind, good: a.made, call: e.call, dir: meta.dir ?? null, depth: meta.depth ?? null };
        }
        return {
          type: a.kind === 'run' ? 'run' : a.kind === 'penalty' ? 'penalty' : 'pass',
          call: e.call, dir: meta.dir ?? null, depth: meta.depth ?? null,
          // the players the narration names, so the picture matches the words
          players: {
            passer: e.players?.passer?.id ?? null, target: e.players?.target?.id ?? null,
            carrier: e.players?.carrier?.id ?? null, defender: e.players?.defender?.id ?? null,
          },
          yards: a.yards, air: a.air ?? null, loc: a.loc, tgt: TARGET[a.carrierPos] ?? null,
          flags: {
            inc: a.inc, int: a.int, fumble: a.fumble, td: a.td, oob: a.oob, first: e.first,
            sack: a.kind === 'sack', scramble: a.kind === 'scramble', penalty: a.penalty,
            safety: Boolean(e.flags & FL_SAFETY), downs: e.turnover && !a.int && !a.fumble, defTd: a.defTd,
          },
        };
      }
      case 'kneel':
      case 'spike':
        return { type: a.kind, yards: a.yards, flags: {} };
      case 'fg':
        return { type: 'fg', made: a.made, blocked: a.blocked, dist: a.dist };
      case 'xp':
        return { type: 'xp', made: a.made };
      case 'punt':
        return { type: 'punt', net: a.net, recvYl: a.recvYl, touchback: e.punt?.touchback, retTd: e.punt?.retTd, blocked: e.punt?.blocked };
      case 'kickoff':
      case 'onside':
        return { type: 'kickoff', onside: a.kind === 'onside', recovered: e.kick?.recovered, recvYl: a.recvYl, td: e.kick?.retTd, touchback: e.kick?.touchback };
      default:
        return null;
    }
  }

  // --- end of game ----------------------------------------------------------------------------

  summary() {
    const s = this.game.summary();
    const decisions = s.decisions.map((d) => {
      const mark = MARKS[d.color] || markFor(d.delta);
      return { mark, symbol: SYMBOLS[mark], lost: Math.max(0, d.delta), label: d.chosen, best: d.best, kind: d.kind };
    });
    const r = s.real;
    const half = s.result === 'half';
    return {
      result: RESULTS[s.result] || 'T', half, ot: s.overtime,
      mine: s.score.user, theirs: s.score.opp,
      decisions, squares: decisions.map((d) => d.mark),
      percentile: s.percentile == null ? null : s.percentile / 100,
      vsTypical: s.typical?.wpa ?? null,
      winChance: s.winChance ?? null,
      lookalike: lookalikeView(s.lookalike),
      measures: s.measures,
      real: r ? {
        coach: r.coach, callLabel: r.callLabel, drive: r.drive, verdict: r.verdict,
        final: r.final ? { mine: r.final.user, opp: r.final.opp } : null,
        // first-half spots compare net points before the half
        points: half ? { mine: r.mine, theirs: r.theirs } : null,
      } : { coach: null },
    };
  }
}


function gradeView(g) {
  const lost = Math.max(0, g.delta);
  const mark = MARKS[g.color] || markFor(lost);
  const options = g.options.map((o) => ({ label: o.label, wp: o.wp, freq: o.freq ?? null, chosen: o.chosen, best: o.best }));
  return {
    mark, symbol: SYMBOLS[mark], word: GRADE_WORDS[mark], lost,
    chosen: options.find((o) => o.chosen) || null, best: options.find((o) => o.best) || null,
    options,
  };
}
