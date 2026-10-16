// Game: one coaching session on a spot. The UI asks for the current decision, may start
// grading it early (prefetch), then acts; the game grades the choice by simulation,
// resolves it with a real play and plays automatic events (opponent timeouts) until the
// next decision. See docs/ENGINE.md for the object shapes.

import { FL, LOOKS } from './data.js';
import { Draws, SLOT, hashInts, seedOf } from './rng.js';
import {
  ballText, callTimeout, canOnside, clockText, downText, fgDistance, halfSeconds, inStopWindow,
  initialState, isSecondHalf, marginFor, other, spotText,
} from './rules.js';
import {
  buildContext, describe, fgChance, matchupTable, onsideRate, playOutcome, resolveKickoff, resolvePat,
  resolveSnap, situationKey,
} from './resolve.js';
import * as policy from './policy.js';
import { outcomeValue } from './sim.js';
import { addMeasures, emptyMeasures, gradeOf, lookalike, percentile, typicalAt } from './grade.js';

export const ROUND1 = 500;           // runs per option, first round (every option)
export const ROUND2 = 6000;          // runs per option, second round (top 3 + the choice)
export const AFTER_RUNS = 600;       // runs for the win chance after a play
export const TOP = 3;
export const TEMPOS = ['hurry', 'normal', 'milk'];
const TEND_MAX = 12;                 // recent calls the defense remembers
const STREAM = { play: 2, look: 3, r1: 101, r2: 102, after: 103, now: 104 };
const GRADED = new Set(['offense', 'defense', 'pat', 'kickoff', 'kick_defense']);
const CLOCK_LABEL = { hurry: 'no-huddle', normal: 'huddle', milk: 'milk the clock', to: 'timeout first' };
const LOOK_LABEL = { base: 'Base defense', blitz: 'Blitz', load: 'Load the box', soft: 'Play it soft' };
const LOOK_TEXT = { base: 'Base defense', blitz: 'Showing blitz', load: 'Loaded box', soft: 'Light box' };
// Points a real drive (nflverse fixed_drive_result) was worth to the team with the ball.
const DRIVE_POINTS = { touchdown: 7, 'field goal': 3, 'opp touchdown': -7, 'defensive touchdown': -7, safety: -2 };

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** The coaching session. Create with Engine#newGame. */
export class Game {
  /**
   * @param {import('./index.js').Engine} eng
   * @param {object} spot spots/<id>.json
   * @param {{mode?: 'daily'|'survivor', seed?: number, tendencies?: string[],
   *   runs?: {r1?: number, r2?: number, after?: number}}} [opts] runs: simulations per option
   *   in grading rounds 1 and 2 and for the win chance after a play (tests, slow devices)
   */
  constructor(eng, spot, { mode = 'daily', seed, tendencies = [], runs = {} } = {}) {
    this.eng = eng;
    this.lib = eng.lib;
    this.spot = spot;
    this.mode = mode;
    this.seed = (seed ?? seedOf('daily', spot.id)) >>> 0;
    this.ctx = buildContext(spot);
    this.user = this.ctx.user;
    this.start = initialState(spot);
    this.state = this.start;
    this.seq = 0;
    this.history = [];
    this.tend = tendencies.filter((id) => this.lib.callIndex.has(id)).slice(-TEND_MAX);
    this.runs = { r1: ROUND1, r2: ROUND2, after: AFTER_RUNS, ...runs };
    this._decision = null;
    this._jobs = new Map();
    this._wp = new Map();
    this._shares = new WeakMap();
    this._intents = new WeakMap();
    this._busy = false;
  }

  // -------------------------------------------------------------------------------------
  // Decisions.

  /**
   * What the user decides now (or an automatic event to acknowledge). Cached until act().
   * @returns {object} decision (ENGINE.md "Decisions")
   */
  decision() {
    if (!this._decision || this._decision.seq !== this.seq) this._decision = this._buildDecision();
    return this._decision;
  }

  /** Random draws of the current decision for a purpose (the same on every replay). */
  _draws(stream) {
    return new Draws(hashInts(this.seed, this.seq, stream));
  }

  _situation(s) {
    const user = this.user;
    const opp = other(user);
    const userBall = s.pos === user;
    return {
      qtr: s.qtr,
      clock: s.clock,
      clockText: clockText(s),
      halfSeconds: halfSeconds(s),
      running: s.running,
      phase: s.phase,
      possession: userBall ? 'user' : 'opp',
      offense: s.teams[s.pos],
      down: s.down,
      ytg: s.ytg,
      yl: s.yl,
      downText: downText(s),
      ballText: ballText(s),
      userView: userBall ? spotText(s.yl) : spotText(100 - s.yl),
      score: { user: s.score[user], opp: s.score[opp] },
      margin: marginFor(s, user),
      timeouts: { user: s.to[user], opp: s.to[opp] },
    };
  }

  _buildDecision() {
    const s = this.state;
    const user = this.user;
    const base = { seq: this.seq, state: s, situation: this._situation(s), look: null };
    if (s.phase === 'done') return { ...base, kind: 'done', team: null, prompt: 'Final', options: [] };
    if (s.phase === 'pat') {
      if (s.pos === user) return this._patDecision(base);
      return this._auto(base, s.pos, 'pat', `${s.teams[s.pos]} try after the touchdown`);
    }
    if (s.phase === 'kickoff') {
      if (s.kicker === user && !s.free && canOnside(s, user)) return this._kickoffDecision(base);
      const who = s.teams[s.kicker];
      return this._auto(base, s.kicker, 'kickoff', `${who} ${s.free ? 'free kick' : 'kick off'}`);
    }
    if (s.pos === user) return this._offenseDecision(base);
    // The opponent's intended action uses the same draws as the snap that will resolve it.
    const intent = policy.offenseAction(this.lib, this.ctx, s, this._draws(STREAM.play));
    if (intent.type === 'fg' || intent.type === 'punt') return this._kickDefenseDecision(base, intent);
    if ((intent.type === 'kneel' || intent.type === 'spike') && !(s.running && s.to[user] > 0)) {
      return this._auto(base, s.pos, intent.type, `${s.teams[s.pos]} ${intent.type === 'kneel' ? 'kneel' : 'spike the ball'}`);
    }
    return this._defenseDecision(base, intent);
  }

  _auto(base, team, event, text) {
    return { ...base, kind: 'auto', team, prompt: text, auto: { event, team, text }, options: [{ id: 'auto', type: 'auto', label: 'Continue' }] };
  }

  /**
   * NFL numbers for a call in the current situation: its real plays (untilted, applied at
   * the current spot), with the family's sacks and scrambles mixed in at their rate.
   */
  _callStats(c, key, s, freq) {
    const lib = this.lib;
    const f = lib.family[c];
    const parts = [[lib.pool(c, key), 1]];
    if (f >= 0) {
      const r = lib.pressureRate(f, key);
      parts[0][1] = 1 - r;
      parts.push([lib.pressurePool(f, key), r]);
    }
    const t = { avg: 0, conv: 0, inc: 0, oob: 0, td: 0, tov: 0 };
    let n = 0;
    for (const [pool, weight] of parts) {
      const one = { avg: 0, conv: 0, inc: 0, oob: 0, td: 0, tov: 0 };
      let m = 0;
      for (let j = 0; j < pool.n; j++) {
        const i = pool.idx[j];
        if (lib.fl[i] & FL.NOPLAY) continue;
        const o = playOutcome(lib, i, s);
        m++;
        one.avg += o.tov ? 0 : o.gain;
        if (!o.tov && (o.td || o.auto1 || o.gain >= s.ytg)) one.conv++;
        if (o.inc) one.inc++;
        if (o.oob) one.oob++;
        if (o.td) one.td++;
        if (o.tov) one.tov++;
      }
      n += m;
      if (m) for (const k of Object.keys(t)) t[k] += (weight * one[k]) / m;
    }
    return { freq, ...t, n };
  }

  /** The look the defense shows: NFL frequencies, adapted to the user's recent calls. */
  _lookOdds(s) {
    const lib = this.lib;
    const base = lib.lookMix(situationKey(s));
    const p = Array.from(base);
    if (this.tend.length) {
      const mt = matchupTable(lib);
      const edge = [0, 0, 0, 0];
      let wsum = 0;
      this.tend.forEach((id, i) => {
        const w = 0.85 ** (this.tend.length - 1 - i);
        const c = lib.callIndex.get(id);
        wsum += w;
        for (let j = 0; j < 4; j++) edge[j] -= w * mt[c * 4 + j];
      });
      const conf = this.tend.length / (this.tend.length + 4);
      for (let j = 0; j < 4; j++) p[j] *= Math.exp((1.4 * conf * edge[j]) / wsum);
    }
    const total = sum(p);
    return { base: Array.from(base), odds: p.map((x) => x / total) };
  }

  _offenseDecision(base) {
    const s = this.state;
    const lib = this.lib;
    const user = this.user;
    const key = situationKey(s);
    const mix = lib.mix(key);
    const hs = halfSeconds(s);
    const m = marginFor(s, user);
    const h2 = isSecondHalf(s);
    const looks = this._lookOdds(s);
    let t = this._draws(STREAM.look).u(SLOT.LOOK);
    let look = 3;
    for (let j = 0; j < 4; j++) {
      t -= looks.odds[j];
      if (t < 0) {
        look = j;
        break;
      }
    }
    const options = [];
    lib.calls.forEach((call, c) => {
      if (c === lib.hail && !(hs <= 30 && s.yl >= 30)) return;
      if (c === lib.sneak && s.ytg > 3) return;
      options.push({
        id: call.id, type: 'play', call: call.id, label: call.label, family: call.family, kind: call.kind,
        dir: call.dir, depth: call.depth || null, nfl: this._callStats(c, key, s, mix.freq[c]),
      });
    });
    const needTime = !h2 || m <= 0;
    const toLeft = s.to[user];
    if (s.running && s.down <= 3 && needTime && hs <= 180) options.push({ id: 'spike', type: 'spike', label: 'Spike the ball' });
    if (policy.kneelOffered(s)) options.push({ id: 'kneel', type: 'kneel', label: 'Kneel' });
    const p = fgChance(lib, this.ctx, user, s.yl);
    const kickable = !s.running || hs >= 7 || toLeft > 0;
    const late = h2 ? hs <= 300 : hs <= 120;
    if (kickable && ((s.down === 4 && p >= 0.05) || (hs <= 20 && p >= 0.2) || (s.down === 3 && hs <= 40 && p >= 0.4) || (late && p >= 0.3))) {
      const rushed = s.running && hs <= 25 ? fgChance(lib, this.ctx, user, s.yl, true) : null;
      options.push({ id: 'fg', type: 'fg', label: `Field goal (${fgDistance(s.yl)} yards)`, fg: { dist: fgDistance(s.yl), p, rushed } });
    }
    if (s.running && toLeft > 0 && needTime && hs > 5 && hs <= 60 && s.yl <= 40 && p >= 0.3 && (!h2 || m >= -3)) {
      options.push({ id: 'rundown', type: 'fg', rundown: true, label: 'Run it down, timeout at 0:03, kick', fg: { dist: fgDistance(s.yl), p, rushed: null } });
    }
    if (s.down === 4 && s.yl >= 30) options.push({ id: 'punt', type: 'punt', label: 'Punt' });
    const usual = policy.usualTempo(lib, this.ctx, s);
    return {
      ...base,
      kind: 'offense',
      team: user,
      prompt: 'Your call',
      look: LOOKS[look],
      lookIndex: look,
      lookText: LOOK_TEXT[LOOKS[look]],
      lookOdds: looks.odds,
      lookBase: looks.base,
      tempo: s.running ? { default: usual, choices: TEMPOS } : null,
      timeout: { available: s.running && toLeft > 0, left: toLeft },
      oob: { available: inStopWindow(s) },
      defaults: { tempo: s.running ? usual : null, timeout: false, oob: false },
      options,
    };
  }

  _defenseDecision(base, intent) {
    const s = this.state;
    const user = this.user;
    const quiet = intent.type === 'kneel' || intent.type === 'spike';
    const lm = this.lib.lookMix(situationKey(s));
    const looks = quiet ? [0] : [0, 1, 2, 3];
    return {
      ...base,
      kind: 'defense',
      team: user,
      prompt: quiet ? `${s.teams[s.pos]} are lining up to ${intent.type}` : 'Your defense',
      offense: quiet ? intent.type : 'play',
      fourth: s.down === 4 && intent.type === 'play' ? 'go' : undefined,
      timeout: { available: s.running && s.to[user] > 0, left: s.to[user] },
      defaults: { timeout: false },
      options: looks.map((j) => ({ id: LOOKS[j], type: 'defense', look: LOOKS[j], label: LOOK_LABEL[LOOKS[j]], nfl: { freq: lm[j] } })),
    };
  }

  _kickDefenseDecision(base, intent) {
    const s = this.state;
    const user = this.user;
    const fg = intent.type === 'fg';
    const dist = fgDistance(s.yl);
    const d = {
      ...base,
      kind: 'kick_defense',
      team: user,
      kick: intent.type,
      prompt: fg ? `They're kicking a field goal (about ${dist} yards)` : "They're punting",
      fg: fg ? { dist, p: fgChance(this.lib, this.ctx, s.pos, s.yl) } : null,
      timeout: { available: s.running && s.to[user] > 0, left: s.to[user] },
      defaults: { timeout: false },
      options: [
        { id: 'safe', type: 'kick_defense', block: false, label: fg ? 'Stay home' : 'Set up the return' },
        { id: 'block', type: 'kick_defense', block: true, label: fg ? 'Go for the block' : 'Rush the punt' },
      ],
    };
    this._intents.set(d, intent);
    return d;
  }

  _patDecision(base) {
    const lib = this.lib;
    const user = this.user;
    const mix = lib.twoMix();
    const rate = lib.special.xp?.rate ?? 0.95;
    const z = Math.log(rate / (1 - rate)) + this.ctx.fgShift[user];
    const options = [{ id: 'xp', type: 'pat', kind: 'xp', label: 'Kick the extra point', p: 1 / (1 + Math.exp(-z)) }];
    const convRate = (pool) => {
      let good = 0;
      for (let j = 0; j < pool.n; j++) {
        const o = playOutcome(lib, pool.idx[j], { yl: 2 });
        if (o.td && !o.tov) good++;
      }
      return pool.n ? good / pool.n : 0;
    };
    lib.calls.forEach((call, c) => {
      if (c === lib.hail) return;
      const pool = lib.twoPool(c);
      const f = lib.family[c];
      const r = f >= 0 ? lib.twoPressureRate(f) : 0;
      const conv = (1 - r) * convRate(pool) + (r ? r * convRate(lib.twoPool(lib.nCalls + f)) : 0);
      options.push({
        id: `two:${call.id}`, type: 'pat', kind: 'two', call: call.id, label: `Go for two: ${call.label}`,
        family: call.family, nfl: { freq: mix.freq[c], conv, n: pool.n },
      });
    });
    return { ...base, kind: 'pat', team: user, prompt: 'Touchdown! Kick it or go for two?', options };
  }

  _kickoffDecision(base) {
    return {
      ...base,
      kind: 'kickoff',
      team: this.user,
      prompt: 'Kickoff',
      options: [
        { id: 'deep', type: 'kickoff', onside: false, label: 'Kick it deep' },
        { id: 'onside', type: 'kickoff', onside: true, label: 'Onside kick', p: onsideRate(this.lib) },
      ],
    };
  }

  // -------------------------------------------------------------------------------------
  // Options: public action -> graded option {key, label, action, group, opt (internal)}.

  _clockCode(s, tempo, timeout, team) {
    if (!s.running) return '-';
    if (timeout && s.to[team] > 0) return 'to';
    return TEMPOS.includes(tempo) ? tempo : policy.usualTempo(this.lib, this.ctx, s);
  }

  /** Normalise a public action into a graded option for decision `d`. */
  _option(d, action) {
    const s = d.state;
    const lib = this.lib;
    const user = this.user;
    switch (d.kind) {
      case 'offense': {
        const code = this._clockCode(s, action.tempo, action.timeout, user);
        const suffix = code === '-' ? '' : `, ${CLOCK_LABEL[code]}`;
        const tempo = TEMPOS.includes(code) ? code : action.type === 'kneel' ? 'milk' : 'normal';
        const sim = (a) => ({ kind: 'offense', a, look: d.lookIndex });
        switch (action.type) {
          case 'play': {
            const c = lib.callId(action.call);
            const oob = !!action.oob && inStopWindow(s);
            const a = { type: 'play', call: c, tempo, timeout: code === 'to', oob };
            return {
              key: `play:${action.call}:${code}${oob ? '+oob' : ''}`, group: action.call,
              label: `${lib.calls[c].label}${suffix}${oob ? ', get out of bounds' : ''}`,
              action: { type: 'play', call: action.call, tempo: TEMPOS.includes(code) ? code : null, timeout: code === 'to', oob },
              opt: sim(a), clock: code, oob,
            };
          }
          case 'spike':
            return { key: 'spike', group: 'spike', label: 'Spike the ball', action: { type: 'spike' }, opt: sim({ type: 'spike' }), clock: '-' };
          case 'kneel':
            return {
              key: `kneel:${code}`, group: 'kneel', label: `Kneel${suffix}`,
              action: { type: 'kneel', tempo: TEMPOS.includes(code) ? code : null, timeout: code === 'to' },
              opt: sim({ type: 'kneel', tempo, timeout: code === 'to' }), clock: code,
            };
          case 'fg': {
            if (action.rundown && s.running && s.to[user] > 0) {
              return {
                key: 'fg:rundown', group: 'fg', label: 'Run it down, timeout at 0:03, kick',
                action: { type: 'fg', rundown: true, timeout: true }, opt: sim({ type: 'fg', rundown: true, timeout: true, tempo: 'milk' }), clock: 'rundown',
              };
            }
            const fire = code !== '-' && code !== 'to' && (code === 'hurry' || halfSeconds(s) <= 25);
            const c2 = fire ? 'hurry' : code;
            return {
              key: `fg:${c2}`, group: 'fg', label: `Field goal${fire ? ', rushed' : c2 === '-' ? '' : `, ${CLOCK_LABEL[c2]}`}`,
              action: { type: 'fg', timeout: c2 === 'to', tempo: TEMPOS.includes(c2) ? c2 : null },
              opt: sim({ type: 'fg', timeout: c2 === 'to', tempo: TEMPOS.includes(c2) ? c2 : 'normal' }), clock: c2,
            };
          }
          case 'punt':
            return {
              key: `punt:${code}`, group: 'punt', label: `Punt${suffix}`,
              action: { type: 'punt', timeout: code === 'to', tempo: TEMPOS.includes(code) ? code : null },
              opt: sim({ type: 'punt', timeout: code === 'to', tempo }), clock: code,
            };
          default:
            throw new Error(`not an offensive action: ${action.type}`);
        }
      }
      case 'defense': {
        if (action.type !== 'defense') throw new Error(`expected a defense action, got ${action.type}`);
        const look = LOOKS.indexOf(action.look);
        if (look < 0) throw new Error(`unknown look: ${action.look}`);
        const to = !!action.timeout && s.running && s.to[user] > 0;
        return {
          key: `def:${action.look}${to ? ':to' : ''}`, group: action.look,
          label: `${LOOK_LABEL[action.look]}${to ? ', timeout first' : ''}`,
          action: { type: 'defense', look: action.look, timeout: to },
          opt: { kind: 'defense', look, timeout: to, fourth: d.fourth },
        };
      }
      case 'kick_defense': {
        if (action.type !== 'kick_defense') throw new Error(`expected a kick_defense action, got ${action.type}`);
        const to = !!action.timeout && s.running && s.to[user] > 0;
        const block = !!action.block;
        const label = d.options.find((o) => o.block === block).label;
        return {
          key: `kd:${block ? 'block' : 'safe'}${to ? ':to' : ''}`, group: block ? 'block' : 'safe',
          label: `${label}${to ? ', timeout first' : ''}`,
          action: { type: 'kick_defense', block, timeout: to },
          opt: { kind: 'kick_defense', a: this._intents.get(d), block, timeout: to },
        };
      }
      case 'pat': {
        if (action.type !== 'pat') throw new Error(`expected a pat action, got ${action.type}`);
        if (action.kind === 'two') {
          const c = lib.callId(action.call);
          return {
            key: `pat:two:${action.call}`, group: 'two', label: `Go for two: ${lib.calls[c].label}`,
            action: { type: 'pat', kind: 'two', call: action.call }, opt: { kind: 'pat', a: { kind: 'two', call: c } },
          };
        }
        return { key: 'pat:xp', group: 'xp', label: 'Kick the extra point', action: { type: 'pat', kind: 'xp' }, opt: { kind: 'pat', a: { kind: 'xp' } } };
      }
      case 'kickoff': {
        if (action.type !== 'kickoff') throw new Error(`expected a kickoff action, got ${action.type}`);
        const onside = !!action.onside;
        return {
          key: onside ? 'ko:onside' : 'ko:deep', group: onside ? 'onside' : 'deep', label: onside ? 'Onside kick' : 'Kick it deep',
          action: { type: 'kickoff', onside }, opt: { kind: 'kickoff', onside },
        };
      }
      default:
        throw new Error(`decision ${d.kind} takes no graded action`);
    }
  }

  /** Every menu option of a decision under the given clock settings. Trick calls only on request. */
  _baseOptions(d, settings = {}, withTrick = false) {
    const lib = this.lib;
    const out = [];
    for (const e of d.options) {
      if (d.kind === 'offense' && e.type === 'play' && lib.isTrick[lib.callId(e.call)] && !withTrick) continue;
      if (d.kind === 'pat' && e.kind === 'two' && lib.isTrick[lib.callId(e.call)] && !withTrick) continue;
      const action = { ...e, tempo: settings.tempo, timeout: settings.timeout, oob: settings.oob && e.type === 'play' };
      if (d.kind === 'defense' || d.kind === 'kick_defense') action.timeout = settings.timeout;
      out.push(this._option(d, action));
    }
    return out;
  }

  /** Clock alternatives (every tempo, timeout, out of bounds) for the given offensive option groups. */
  _alternatives(d, groups) {
    const s = d.state;
    const codes = s.running ? [...TEMPOS.map((t) => ({ tempo: t, timeout: false })), ...(s.to[this.user] > 0 ? [{ timeout: true }] : [])] : [{}];
    const oobs = inStopWindow(s) ? [false, true] : [false];
    const out = [];
    for (const g of groups) {
      const e = d.options.find((o) => (o.type === 'play' ? o.call : o.id) === g || (g === 'fg' && o.id === 'fg'));
      if (!e || e.type === 'spike' || e.rundown) continue;
      for (const c of codes) for (const oob of e.type === 'play' ? oobs : [false]) out.push(this._option(d, { ...e, ...c, oob }));
    }
    return out;
  }

  /** Defensive alternatives: the same looks (or kick defenses) with a timeout first. */
  _timeoutVariants(d) {
    if ((d.kind !== 'defense' && d.kind !== 'kick_defense') || !d.timeout.available) return [];
    return this._baseOptions(d, { timeout: true });
  }

  // -------------------------------------------------------------------------------------
  // Grading.

  _job(d) {
    let job = this._jobs.get(d.seq);
    if (!job) {
      job = { d, r1: new Map(), r2: new Map(), opts: new Map(), chain: Promise.resolve() };
      this._jobs.set(d.seq, job);
    }
    return job;
  }

  _enqueue(job, fn) {
    job.chain = job.chain.catch(() => {}).then(fn);
    return job.chain;
  }

  async _evalRound(job, options, round) {
    const map = round === 1 ? job.r1 : job.r2;
    const todo = [];
    const seen = new Set();
    for (const o of options) {
      if (!o || map.has(o.key) || seen.has(o.key)) continue;
      seen.add(o.key);
      todo.push(o);
      job.opts.set(o.key, o);
    }
    if (!todo.length) return;
    const n = round === 1 ? this.runs.r1 : this.runs.r2;
    const seed = hashInts(this.seed, job.d.seq, round === 1 ? STREAM.r1 : STREAM.r2);
    const means = await this.eng.pool.evaluate(this.ctx, job.d.state, todo.map((o) => o.opt), { n, seed });
    todo.forEach((o, i) => map.set(o.key, means[i]));
  }

  _ranked(job) {
    return [...job.r1.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => job.opts.get(key));
  }

  async _firstRound(job, settings) {
    const d = job.d;
    await this._evalRound(job, [...this._baseOptions(d, settings || d.defaults), ...this._timeoutVariants(d)], 1);
    if (d.kind === 'offense') {
      const groups = [];
      for (const o of this._ranked(job)) {
        if (!groups.includes(o.group)) groups.push(o.group);
        if (groups.length >= TOP) break;
      }
      await this._evalRound(job, this._alternatives(d, groups), 1);
    }
  }

  /**
   * Start grading a decision in the background (first round for the default or given
   * clock settings, plus a speculative second round for the leaders). Safe to call
   * repeatedly, e.g. when the user changes the tempo toggle.
   * @param {object} [d] the decision (default: the current one)
   * @param {{tempo?: string, timeout?: boolean, oob?: boolean}} [settings]
   * @returns {Promise<void>}
   */
  prefetch(d = this.decision(), settings) {
    if (!GRADED.has(d.kind) || d.seq !== this.seq) return Promise.resolve();
    const job = this._job(d);
    return this._enqueue(job, async () => {
      await this._firstRound(job, settings);
      await this._evalRound(job, this._ranked(job).slice(0, TOP), 2);
    });
  }

  async _grade(d, chosen, action) {
    const job = this._job(d);
    await this._enqueue(job, async () => {
      await this._firstRound(job, d.defaults);
      const trick = d.kind === 'offense' || d.kind === 'pat' ? !!(action.call && this.lib.isTrick[this.lib.callId(action.call)]) : false;
      const settings = { tempo: action.tempo, timeout: action.timeout, oob: action.oob };
      await this._evalRound(job, [chosen, ...this._baseOptions(d, settings, trick)], 1);
      await this._evalRound(job, [...this._ranked(job).slice(0, TOP), chosen], 2);
    });
    return this._gradeResult(job, chosen);
  }

  /** Typical NFL frequency of each graded option (normalised over the list). */
  _frequencies(d, opts) {
    const lib = this.lib;
    const s = d.state;
    const user = this.user;
    const hs = halfSeconds(s);
    const raw = opts.map((o) => {
      switch (d.kind) {
        case 'defense': {
          const lm = lib.lookMix(situationKey(s));
          return lm[o.opt.look] * (d.timeout.available ? (o.opt.timeout ? 0.15 : 0.85) : 1);
        }
        case 'kick_defense':
          return (o.opt.block ? 0.2 : 0.8) * (d.timeout.available ? (o.opt.timeout ? 0.1 : 0.9) : 1);
        case 'pat': {
          const share = lib.go2Rate(marginFor(s, user), isSecondHalf(s) && (s.qtr >= 5 || hs <= 300));
          return o.opt.a.kind === 'xp' ? 1 - share : share * lib.twoMix().freq[o.opt.a.call];
        }
        case 'kickoff': {
          const p = policy.kickoffAction(lib, this.ctx, s).onside ? 0.8 : 0.03;
          return o.opt.onside ? p : 1 - p;
        }
        default:
          return this._offenseFrequency(d, o);
      }
    });
    const total = sum(raw);
    return raw.map((x) => (total > 0 ? x / total : 1 / raw.length));
  }

  _offenseFrequency(d, o) {
    const lib = this.lib;
    const s = d.state;
    const hs = halfSeconds(s);
    const m = marginFor(s, this.user);
    const usual = d.defaults.tempo;
    const leadingLate = isSecondHalf(s) && m > 0;
    let clock = 1;
    if (s.running) {
      if (o.clock === 'to') clock = leadingLate ? 0.03 : 0.14;
      else if (o.clock === usual) clock = 0.8;
      else clock = 0.03;
    }
    if (o.oob) return 0;
    const a = o.opt.a;
    let share = 1;
    if (s.down === 4) {
      const fp = policy.fourthProbs(lib, this.ctx, s) || (s.yl <= 40 ? { go: 0.35, fg: 0.55, punt: 0.1 } : { go: 0.15, fg: 0.05, punt: 0.8 });
      if (a.type === 'fg') return fp.fg * clock;
      if (a.type === 'punt') return fp.punt * clock;
      share = fp.go;
    } else if (a.type === 'fg') {
      return (a.rundown ? 0.6 : hs <= 10 ? 0.6 : hs <= 20 || (s.down === 3 && hs <= 40) ? 0.2 : 0.02) * clock;
    }
    if (a.type === 'kneel') return (m > 0 ? 0.5 : 0.1) * clock;
    if (a.type === 'spike') return 0.06;
    if (a.type !== 'play') return 0.02 * clock;
    return share * this._callShares(d)[a.call] * clock;
  }

  /**
   * How often NFL play-callers make each call in this situation, given the look the
   * defense shows: P(call) x P(look | call), normalised over all calls.
   */
  _callShares(d) {
    let shares = this._shares.get(d);
    if (!shares) {
      const lib = this.lib;
      const key = situationKey(d.state);
      const mix = lib.mix(key);
      const w = Array.from(mix.freq, (f, c) => f * lib.lookShares(lib.pool(c, key))[d.lookIndex]);
      const total = sum(w);
      shares = w.map((x) => (total > 0 ? x / total : 1 / w.length));
      this._shares.set(d, shares);
    }
    return shares;
  }

  _gradeResult(job, chosen) {
    const d = job.d;
    let maxR2 = -Infinity;
    for (const v of job.r2.values()) maxR2 = Math.max(maxR2, v);
    const final = (key) => (job.r2.has(key) ? job.r2.get(key) : Math.min(job.r1.get(key), maxR2));
    const opts = [...job.r1.keys()].map((k) => job.opts.get(k));
    const q = this._frequencies(d, opts);
    const rows = opts.map((o, i) => ({
      key: o.key, label: o.label, action: o.action, wp: final(o.key), n: job.r2.has(o.key) ? this.runs.r2 : this.runs.r1, freq: q[i],
      chosen: o.key === chosen.key, best: false,
    }));
    rows.sort((a, b) => b.wp - a.wp);
    rows[0].best = true;
    const best = rows[0].wp;
    const mine = final(chosen.key);
    const delta = Math.max(0, best - mine) * 100;
    const pct = { wp: rows.map((r) => r.wp), q: rows.map((r) => r.freq), best, chosen: mine };
    const typ = typicalAt(pct);
    const g = gradeOf(delta);
    return {
      grade: {
        chosen: mine, best, delta, symbol: g.symbol, color: g.color, word: g.word,
        chosenKey: chosen.key, chosenLabel: chosen.label, bestKey: rows[0].key, bestLabel: rows[0].label,
        bestAction: rows[0].action, typical: typ.wp, options: rows,
      },
      pct,
      measures: this._measures(d, chosen, rows),
    };
  }

  /** This decision's contribution to the look-alike measures. */
  _measures(d, chosen, rows) {
    const lib = this.lib;
    const out = emptyMeasures();
    const add = (m, mine, num, den) => {
      if (!(den > 0)) return;
      out[m].n += 1;
      out[m].mine += mine;
      out[m].exp += num / den;
    };
    const callOf = (r) => (r.action.type === 'play' ? lib.callId(r.action.call) : -1);
    if (d.kind === 'offense') {
      const plays = rows.filter((r) => callOf(r) >= 0);
      const c = chosen.action.type === 'play' ? lib.callId(chosen.action.call) : -1;
      if (c >= 0) {
        add('pass', lib.isPass[c], sum(plays.map((r) => r.freq * lib.isPass[callOf(r)])), sum(plays.map((r) => r.freq)));
        if (lib.isPass[c]) {
          const passes = plays.filter((r) => lib.isPass[callOf(r)]);
          add('deep', lib.isDeep[c], sum(passes.map((r) => r.freq * lib.isDeep[callOf(r)])), sum(passes.map((r) => r.freq)));
        }
      }
      const s = d.state;
      if (s.down === 4 && s.ytg <= 5 && s.yl < 50) add('go', c >= 0 ? 1 : 0, sum(plays.map((r) => r.freq)), sum(rows.map((r) => r.freq)));
    } else if (d.kind === 'pat') {
      add('two', chosen.action.kind === 'two' ? 1 : 0, sum(rows.filter((r) => r.action.kind === 'two').map((r) => r.freq)), sum(rows.map((r) => r.freq)));
    }
    return out;
  }

  // -------------------------------------------------------------------------------------
  // Acting.

  /**
   * The user's win chance in the current state (the policy plays on for both teams).
   * @returns {Promise<number>}
   */
  async winChance() {
    const s = this.state;
    if (s.phase === 'done') return outcomeValue(this.lib, this.ctx, s);
    if (!this._wp.has(this.seq)) {
      const seed = hashInts(this.seed, this.seq, STREAM.now);
      this._wp.set(this.seq, this.eng.pool.evaluate(this.ctx, s, [{ kind: 'policy' }], { n: this.runs.after, seed }).then((m) => m[0]));
    }
    return this._wp.get(this.seq);
  }

  /**
   * Make the decision: grade it (awaiting any prefetch), resolve it with a real play, and
   * play automatic follow-ups (the opponent's timeouts).
   * Throws if the game is over, the action does not fit the decision, or another act() is
   * still running.
   * @param {object} action see ENGINE.md "Actions"
   * @returns {Promise<{log: object[], grade: object|null, wpBefore: number, wpAfter: number, state: object}>}
   */
  async act(action) {
    if (this._busy) throw new Error('another action is still being resolved');
    this._busy = true;
    try {
      return await this._act(action);
    } finally {
      this._busy = false;
    }
  }

  async _act(action) {
    const d = this.decision();
    if (d.kind === 'done') throw new Error('the game is over');
    let graded = null;
    let chosen = null;
    if (d.kind === 'auto') {
      if (action && action.type !== 'auto') throw new Error(`expected {type: 'auto'}, got ${action.type}`);
    } else {
      chosen = this._option(d, action);
      graded = await this._grade(d, chosen, chosen.action);
    }
    const wpBefore = graded ? graded.grade.chosen : await this.winChance();
    const before = this.state;
    const log = [];
    let s = this._resolve(d, chosen, log);
    s = this._advance(s, log);
    this.state = s;
    const wpAfter = s.phase === 'done'
      ? outcomeValue(this.lib, this.ctx, s)
      : (await this.eng.pool.evaluate(this.ctx, s, [{ kind: 'policy' }], { n: this.runs.after, seed: hashInts(this.seed, d.seq, STREAM.after) }))[0];
    if (d.kind === 'offense' && chosen.action.type === 'play') {
      this.tend = [...this.tend, chosen.action.call].slice(-TEND_MAX);
    }
    this.history.push({
      seq: d.seq,
      kind: d.kind,
      prompt: d.prompt,
      situation: d.situation,
      look: d.look,
      action: chosen ? chosen.action : { type: 'auto' },
      choice: chosen ? { key: chosen.key, label: chosen.label } : null,
      grade: graded ? graded.grade : null,
      pct: graded ? graded.pct : null,
      measures: graded ? graded.measures : null,
      log: log.map(({ state, ...rest }) => rest),
      wpBefore,
      wpAfter,
      before: { score: before.score, qtr: before.qtr, clock: before.clock },
    });
    this._wp.set(this.seq + 1, Promise.resolve(wpAfter));
    this._jobs.delete(d.seq);
    this.seq += 1;
    this._decision = null;
    return { log, grade: graded ? graded.grade : null, wpBefore, wpAfter, state: s };
  }

  _entry(ev, before, after) {
    return describe(this.lib, this.spot, ev, before, after);
  }

  _timeoutEntry(team, before, after) {
    return this._entry({ type: 'timeout', team, pre: [], clock0: before.clock, qtr0: before.qtr }, before, after);
  }

  _resolve(d, chosen, log) {
    const lib = this.lib;
    const ctx = this.ctx;
    const s0 = this.state;
    const dr = this._draws(STREAM.play);
    const run = (r, before) => {
      log.push(this._entry(r.ev, before, r.state));
      return r.state;
    };
    switch (d.kind) {
      case 'offense':
        return run(resolveSnap(lib, ctx, s0, chosen.opt.a, { look: d.lookIndex, block: false }, dr), s0);
      case 'defense':
      case 'kick_defense': {
        let s = s0;
        if (chosen.opt.timeout) {
          s = callTimeout(s0, this.user);
          log.push(this._timeoutEntry(this.user, s0, s));
        }
        const a = d.kind === 'kick_defense'
          ? chosen.opt.a
          : policy.offenseAction(lib, ctx, s, dr, { fourth: d.fourth, look: chosen.opt.look });
        return run(resolveSnap(lib, ctx, s, a, { look: d.kind === 'defense' ? chosen.opt.look : -1, block: !!chosen.opt.block }, dr), s);
      }
      case 'pat':
        return run(resolvePat(lib, ctx, s0, chosen.opt.a, dr), s0);
      case 'kickoff':
        return run(resolveKickoff(lib, ctx, s0, { onside: chosen.opt.onside }, dr), s0);
      default: {
        if (s0.phase === 'pat') return run(resolvePat(lib, ctx, s0, policy.patAction(lib, ctx, s0, dr), dr), s0);
        if (s0.phase === 'kickoff') return run(resolveKickoff(lib, ctx, s0, policy.kickoffAction(lib, ctx, s0), dr), s0);
        return run(resolveSnap(lib, ctx, s0, policy.offenseAction(lib, ctx, s0, dr), { look: -1, block: false }, dr), s0);
      }
    }
  }

  /** Automatic events before the next decision: the opponent's defensive timeouts. */
  _advance(s, log) {
    if (s.phase === 'snap' && s.pos === this.user && policy.defenseTimeout(this.lib, this.ctx, s)) {
      const t = callTimeout(s, other(this.user));
      log.push(this._timeoutEntry(other(this.user), s, t));
      return t;
    }
    return s;
  }

  // -------------------------------------------------------------------------------------
  // Summary and persistence.

  /** True once the game (or the half, for first-half spots) is over. */
  get over() {
    return this.state.phase === 'done';
  }

  /**
   * End-of-game report (also usable mid-game for the running totals).
   * @returns {object} see ENGINE.md "Summary"
   */
  summary() {
    const s = this.state;
    const user = this.user;
    const opp = other(user);
    const graded = this.history.filter((h) => h.grade);
    const cost = sum(graded.map((h) => Math.max(0, h.grade.best - h.grade.chosen)));
    const typical = graded.map((h) => typicalAt(h.pct));
    const measures = this.history.reduce((acc, h) => (h.measures ? addMeasures(acc, h.measures) : acc), emptyMeasures());
    let result = 'playing';
    if (s.phase === 'done') {
      if (s.winner === null) result = 'half';
      else result = s.winner === user ? 'win' : s.winner === opp ? 'loss' : 'tie';
    }
    const pct = percentile(graded.map((h) => h.pct), this.seed);
    return {
      over: s.phase === 'done',
      mode: this.mode,
      spotId: this.spot.id,
      result,
      won: result === 'win',
      alive: this.mode === 'survivor' ? result === 'win' || result === 'tie' : null,
      overtime: s.qtr >= 5,
      score: { user: s.score[user], opp: s.score[opp] },
      teams: { user: s.teams[user], opp: s.teams[opp] },
      winChance: s.phase === 'done' ? outcomeValue(this.lib, this.ctx, s) : null,
      decisions: graded.map((h) => ({
        seq: h.seq, kind: h.kind, situation: h.situation, chosen: h.choice.label, best: h.grade.bestLabel,
        delta: h.grade.delta, symbol: h.grade.symbol, color: h.grade.color, wpBefore: h.wpBefore, wpAfter: h.wpAfter,
      })),
      squares: graded.map((h) => h.grade.color),
      counts: Object.fromEntries(['green', 'yellow', 'orange', 'red'].map((c) => [c, graded.filter((h) => h.grade.color === c).length])),
      cost: cost * 100,
      typical: {
        cost: sum(typical.map((t) => t.cost)) * 100,
        wpa: sum(graded.map((h, i) => h.grade.chosen - typical[i].wp)) * 100,
      },
      percentile: pct,
      measures,
      lookalike: lookalike(this.lib.coaches, measures),
      real: this._real(),
    };
  }

  _real() {
    const spot = this.spot;
    const real = spot.real;
    if (!real) return null;
    const s = this.state;
    const user = this.user;
    const opp = other(user);
    const me = spot.team;
    const them = s.teams[opp];
    const callIdx = this.lib.callIndex.get(real.call);
    const drive = String(real.drive || '').toLowerCase();
    let verdict = null;
    let mineValue = null;
    let realValue = null;
    if (s.phase === 'done') {
      if (this.start.endAtHalf) {
        mineValue = (s.score[user] - this.start.score[user]) - (s.score[opp] - this.start.score[opp]);
        realValue = DRIVE_POINTS[drive] ?? 0;
      } else if (real.final) {
        mineValue = sign(s.score[user] - s.score[opp]);
        realValue = sign((real.final[me] ?? 0) - (real.final[them] ?? 0));
      }
      if (mineValue !== null) verdict = ['worse', 'same', 'better'][sign(mineValue - realValue) + 1];
    }
    return {
      coach: real.coach?.[me] ?? null,
      call: real.call ?? null,
      callLabel: callIdx === undefined ? null : this.lib.calls[callIdx].label,
      drive: real.drive ?? null,
      final: real.final ? { user: real.final[me] ?? null, opp: real.final[them] ?? null } : null,
      desc: real.desc ?? null,
      verdict,
      mine: mineValue,
      theirs: realValue,
    };
  }

  /** Serializable snapshot (localStorage). Restore with Engine.restore. */
  toJSON() {
    return {
      v: 1,
      spotId: this.spot.id,
      mode: this.mode,
      seed: this.seed,
      seq: this.seq,
      state: this.state,
      history: this.history,
      tend: this.tend,
      runs: this.runs,
    };
  }

  /**
   * Rebuild a game from toJSON() output.
   * @param {import('./index.js').Engine} eng
   * @param {object} json
   * @param {object} spot the spot file for json.spotId
   */
  static fromJSON(eng, json, spot) {
    if (json.v !== 1 || json.spotId !== spot.id) throw new Error('saved game does not match the spot');
    const g = new Game(eng, spot, { mode: json.mode, seed: json.seed, tendencies: json.tend || [], runs: json.runs });
    g.state = json.state;
    g.seq = json.seq;
    g.history = json.history || [];
    return g;
  }
}
