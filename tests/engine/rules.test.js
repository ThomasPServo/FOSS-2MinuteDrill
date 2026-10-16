import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFieldGoal, applyKickoff, applyPunt, applySnap, applyTry, ballText, callTimeout, canOnside,
  clockText, downText, endPeriodDraft, cloneState, halfSeconds, inStopWindow, initialState,
  marginFor, preSnapRunoff,
} from '../../web/js/engine/rules.js';
import { makeSpot } from '../fixtures/synth.js';

// Home NO = 0, away KC = 1. KC (user) has the ball at its own 25, Q4 1:58, down 20-23.
const base = () => initialState(makeSpot());
const at = (over) => ({ ...base(), ...over });
const play = (o) => ({
  gain: 0, dur: 5, inc: false, oob: false, pen: false, noPlay: false, auto1: false, spike: false, kneel: false,
  td: false, safety: false, tov: false, defYl: 0, defTd: false, ...o,
});

test('initial state from a spot', () => {
  const s = base();
  assert.deepEqual(s.teams, ['NO', 'KC']);
  assert.equal(s.user, 1);
  assert.equal(s.pos, 1);
  assert.deepEqual(s.score, [23, 20]);
  assert.deepEqual(s.to, [3, 2]);
  assert.equal(s.receive2h, 0);
  assert.equal(s.warned, true, 'a spot inside 2:00 has had its warning');
  assert.equal(s.phase, 'snap');
  assert.equal(s.endAtHalf, false);
  assert.equal(s.running, false);
  const h1 = initialState(makeSpot({ start: { qtr: 2, clock: 95 } }));
  assert.equal(h1.endAtHalf, true);
  const ko = initialState(makeSpot({ start: { phase: 'kickoff', pos: 'NO' } }));
  assert.equal(ko.kicker, 0);
});

test('timeouts stop the clock after a second of reaction, never past the warning', () => {
  const s = at({ running: true, clock: 100 });
  const t = callTimeout(s, 1);
  assert.equal(t.to[1], 1);
  assert.equal(t.clock, 99);
  assert.equal(t.running, false);
  assert.equal(s.to[1], 2, 'the input is not modified');
  const none = at({ to: [3, 0], running: true });
  assert.equal(callTimeout(none, 1), none, 'no timeouts left: no change');
  const w = callTimeout(at({ qtr: 4, clock: 120.5, warned: false, running: true }), 0);
  assert.equal(w.clock, 120.5);
  const stopped = callTimeout(at({ running: false, clock: 50 }), 0);
  assert.equal(stopped.clock, 50);
});

test('pre-snap runoff: stopped clock, restart credit, two-minute warning', () => {
  assert.equal(preSnapRunoff(at({ running: false }), 30).state.clock, 118);
  const credit = preSnapRunoff(at({ running: true, clock: 100, credit: 4 }), 30);
  assert.equal(credit.state.clock, 74);
  assert.equal(credit.state.credit, 0);
  const warn = preSnapRunoff(at({ qtr: 4, clock: 130, warned: false, running: true }), 30);
  assert.equal(warn.stop, '2mw');
  assert.equal(warn.state.clock, 120);
  assert.equal(warn.state.running, false);
  assert.equal(warn.state.warned, true);
  const q3 = preSnapRunoff(at({ qtr: 3, clock: 130, warned: false, running: true }), 30);
  assert.equal(q3.stop, null, 'no warning in the third quarter');
  assert.equal(q3.state.clock, 100);
});

test('the period ends during the runoff', () => {
  const q1 = preSnapRunoff(at({ qtr: 1, clock: 10, running: true }), 30);
  assert.equal(q1.stop, 'period');
  assert.equal(q1.state.qtr, 2);
  assert.equal(q1.state.clock, 900);
  assert.equal(q1.state.phase, 'snap');
  assert.equal(q1.state.pos, 1, 'same possession into the next quarter');

  const half = preSnapRunoff(at({ qtr: 2, clock: 10, running: true, to: [0, 1], warned: true }), 30);
  assert.equal(half.state.qtr, 3);
  assert.equal(half.state.phase, 'kickoff');
  assert.equal(half.state.kicker, 1, 'the team that did not receive the opening kick receives');
  assert.deepEqual(half.state.to, [3, 3]);
  assert.equal(half.state.warned, false);

  const endHalf = preSnapRunoff(at({ qtr: 2, clock: 10, running: true, endAtHalf: true }), 30);
  assert.equal(endHalf.state.phase, 'done');
  assert.equal(endHalf.state.winner, null);

  const final = preSnapRunoff(at({ clock: 10, running: true }), 30);
  assert.equal(final.state.phase, 'done');
  assert.equal(final.state.winner, 0);

  const tied = preSnapRunoff(at({ clock: 10, running: true, score: [20, 20] }), 30, 0.2);
  assert.equal(tied.state.qtr, 5);
  assert.equal(tied.state.clock, 600);
  assert.equal(tied.state.phase, 'kickoff');
  assert.equal(tied.state.kicker, 1, 'home won the toss (u < 0.5) and receives');
  assert.deepEqual(tied.state.to, [2, 2]);
  assert.deepEqual(tied.state.ot.done, [0, 0]);
});

test('clock after plays: incompletions, out of bounds and penalties by window', () => {
  const s = at({ qtr: 4, clock: 400, warned: false });
  assert.equal(applySnap(s, play({ gain: 5 })).state.running, true);
  assert.equal(applySnap(s, play({ inc: true })).state.running, false);
  const oobEarly = applySnap(s, play({ gain: 5, oob: true, dur: 5 })).state;
  assert.equal(oobEarly.running, true, 'out of bounds at 6:35 does not stop the clock');
  assert.equal(oobEarly.credit, 4);
  const oobLate = applySnap(at({ qtr: 4, clock: 290 }), play({ gain: 5, oob: true })).state;
  assert.equal(oobLate.running, false, 'out of bounds inside 5:00 of the 4th stops it');
  assert.equal(applySnap(at({ qtr: 2, clock: 110 }), play({ gain: 5, oob: true })).state.running, false);
  assert.equal(applySnap(at({ qtr: 2, clock: 200, warned: false }), play({ gain: 5, oob: true })).state.running, true);
  assert.equal(applySnap(at({ qtr: 5, clock: 290, ot: { done: [0, 0] } }), play({ gain: 5, oob: true })).state.running, false);
  const pen = applySnap(s, play({ gain: -10, pen: true, noPlay: true })).state;
  assert.equal(pen.running, true);
  assert.equal(pen.credit, 20);
  assert.equal(applySnap(at({ qtr: 4, clock: 100 }), play({ gain: 5, pen: true, noPlay: true })).state.running, false);
});

test('a play crossing 2:00 triggers the two-minute warning', () => {
  const r = applySnap(at({ qtr: 4, clock: 124, warned: false }), play({ gain: 3, dur: 6 }));
  assert.equal(r.warning, true);
  assert.equal(r.state.clock, 118);
  assert.equal(r.state.running, false);
  assert.equal(r.state.warned, true);
});

test('downs, distance, first downs and turnover on downs', () => {
  const s = at({ down: 1, ytg: 10, yl: 75 });
  const a = applySnap(s, play({ gain: 4 }));
  assert.deepEqual([a.state.down, a.state.ytg, a.state.yl], [2, 6, 71]);
  const b = applySnap(s, play({ gain: 12 }));
  assert.deepEqual([b.state.down, b.state.ytg, b.state.yl, b.first], [1, 10, 63, true]);
  const goal = applySnap(at({ down: 1, ytg: 10, yl: 15 }), play({ gain: 10 }));
  assert.deepEqual([goal.state.ytg, goal.state.yl], [5, 5], 'first and goal');
  const auto = applySnap(at({ down: 3, ytg: 8 }), play({ gain: 5, pen: true, noPlay: true, auto1: true }));
  assert.deepEqual([auto.state.down, auto.state.ytg], [1, 10]);
  const replay = applySnap(at({ down: 3, ytg: 8 }), play({ gain: -10, pen: true, noPlay: true }));
  assert.deepEqual([replay.state.down, replay.state.ytg, replay.state.yl], [3, 18, 85], 'the down is replayed');
  const downs = applySnap(at({ down: 4, ytg: 5, yl: 40 }), play({ gain: 2 }));
  assert.equal(downs.downs, true);
  assert.equal(downs.state.pos, 0);
  assert.equal(downs.state.yl, 62);
  assert.equal(downs.state.running, false);
});

test('kneels and spikes', () => {
  const kneel = applySnap(at({ running: true, clock: 100 }), play({ gain: -1, dur: 1.5, kneel: true }));
  assert.equal(kneel.state.running, true);
  assert.equal(kneel.state.yl, 76);
  assert.equal(kneel.state.clock, 98.5);
  const spike = applySnap(at({ running: true, clock: 30, down: 2, ytg: 4 }), play({ inc: true, spike: true, dur: 1 }));
  assert.equal(spike.state.running, false);
  assert.equal(spike.state.down, 3);
  assert.equal(spike.state.clock, 29);
  const spike4 = applySnap(at({ down: 4, ytg: 4, yl: 30 }), play({ inc: true, spike: true, dur: 1 }));
  assert.equal(spike4.downs, true);
});

test('touchdown, try and kickoff', () => {
  const td = applySnap(at({ yl: 8 }), play({ gain: 8, td: true })).state;
  assert.equal(td.phase, 'pat');
  assert.deepEqual(td.score, [23, 26]);
  assert.equal(td.pos, 1);
  assert.equal(td.running, false);
  const xp = applyTry(td, { two: false, good: true });
  assert.deepEqual(xp.score, [23, 27]);
  assert.equal(xp.phase, 'kickoff');
  assert.equal(xp.kicker, 1);
  const two = applyTry(td, { two: true, good: true });
  assert.deepEqual(two.score, [23, 28]);
  const miss = applyTry(td, { two: true, good: false });
  assert.deepEqual(miss.score, [23, 26]);
});

test('no try after the last-play touchdown unless it can change the result', () => {
  const win = applySnap(at({ yl: 8, clock: 4 }), play({ gain: 8, td: true, dur: 6 })).state;
  assert.equal(win.phase, 'done');
  assert.equal(win.winner, 1, 'KC wins 26-23 without a try');
  const tie = applySnap(at({ yl: 8, clock: 4, score: [26, 20] }), play({ gain: 8, td: true, dur: 6 })).state;
  assert.equal(tie.phase, 'pat', 'tied after the touchdown: the try decides it');
  const after = applyTry(tie, { two: false, good: true });
  assert.equal(after.phase, 'done');
  assert.equal(after.winner, 1);
  const half = applySnap(at({ qtr: 2, clock: 3, yl: 8, endAtHalf: true }), play({ gain: 8, td: true, dur: 6 })).state;
  assert.equal(half.phase, 'pat', 'end of the first half: the try is played');
  const ht = applyTry(half, { two: false, good: true });
  assert.equal(ht.phase, 'done');
  assert.equal(ht.winner, null);
});

test('safety and free kick', () => {
  const s = applySnap(at({ yl: 98 }), play({ gain: -3, safety: true })).state;
  assert.deepEqual(s.score, [25, 20]);
  assert.equal(s.phase, 'kickoff');
  assert.equal(s.kicker, 1);
  assert.equal(s.free, true);
  const ko = applyKickoff(s, { recvYl: 60, dur: 6 });
  assert.equal(ko.pos, 0);
  assert.equal(ko.yl, 60);
  assert.equal(ko.free, false);
});

test('turnovers: return spot and defensive touchdown', () => {
  const int = applySnap(at({ yl: 75 }), play({ tov: true, defYl: 40 })).state;
  assert.equal(int.pos, 0);
  assert.equal(int.yl, 40);
  assert.equal(int.down, 1);
  assert.equal(int.running, false);
  const six = applySnap(at({ yl: 75 }), play({ tov: true, defYl: 0, defTd: true })).state;
  assert.equal(six.phase, 'pat');
  assert.equal(six.pos, 0);
  assert.deepEqual(six.score, [29, 20]);
  const tb = applySnap(at({ yl: 30 }), play({ tov: true, defYl: 104 })).state;
  assert.equal(tb.yl, 80, 'a takeover in the end zone is a touchback');
});

test('field goals: made, missed spot, blocked return, roughing', () => {
  const s = at({ yl: 20 });
  const made = applyFieldGoal(s, { made: true, dur: 5 });
  assert.deepEqual(made.score, [23, 23]);
  assert.equal(made.phase, 'kickoff');
  assert.equal(made.kicker, 1);
  const miss = applyFieldGoal(s, { made: false, dur: 5 });
  assert.equal(miss.pos, 0);
  assert.equal(miss.yl, 73, 'the defense takes over at the spot of the kick');
  const short = applyFieldGoal(at({ yl: 8 }), { made: false, dur: 5 });
  assert.equal(short.yl, 80, 'or at its 20');
  const ret = applyFieldGoal(s, { made: false, blocked: true, retTd: true, dur: 8 });
  assert.equal(ret.phase, 'pat');
  assert.equal(ret.pos, 0);
  const rough = applyFieldGoal(s, { made: false, roughing: true, dur: 4 });
  assert.equal(rough.pos, 1);
  assert.deepEqual([rough.yl, rough.down], [5, 1]);
  const last = applyFieldGoal(at({ yl: 20, clock: 3, score: [20, 20] }), { made: true, dur: 5 });
  assert.equal(last.phase, 'done');
  assert.equal(last.winner, 1, 'a walk-off field goal ends the game');
});

test('punts and kickoffs', () => {
  const s = at({ yl: 70, down: 4 });
  const p = applyPunt(s, { recvYl: 72, dur: 9 });
  assert.equal(p.pos, 0);
  assert.equal(p.yl, 72);
  const muff = applyPunt(s, { recvYl: 72, kickRec: true, dur: 9 });
  assert.equal(muff.pos, 1);
  assert.equal(muff.yl, 28);
  const ret = applyPunt(s, { recvYl: 1, retTd: true, dur: 12 });
  assert.equal(ret.phase, 'pat');
  assert.equal(ret.pos, 0);
  const ko = { ...at({}), phase: 'kickoff', kicker: 1, pos: 1 };
  const deep = applyKickoff(ko, { recvYl: 65, dur: 0 });
  assert.equal(deep.pos, 0);
  assert.equal(deep.yl, 65);
  const onside = applyKickoff(ko, { recvYl: 46, kickRec: true, dur: 3 });
  assert.equal(onside.pos, 1);
  assert.equal(onside.yl, 54);
  assert.equal(canOnside(at({}), 1), true);
  assert.equal(canOnside(at({}), 0), false, 'only the trailing team');
  assert.equal(canOnside(at({ qtr: 3 }), 1), false, 'only in the 4th quarter or overtime');
});

test('an accepted defensive foul on the last play gives an untimed down', () => {
  const r = applySnap(at({ clock: 3, yl: 40 }), play({ gain: 15, pen: true, noPlay: true, auto1: true, dur: 6 }));
  assert.equal(r.untimed, true);
  assert.equal(r.state.phase, 'snap');
  assert.equal(r.state.clock, 0);
  const next = applySnap(r.state, play({ inc: true, dur: 5 }));
  assert.equal(next.state.phase, 'done');
  const offense = applySnap(at({ clock: 3, yl: 40 }), play({ gain: -10, pen: true, noPlay: true, dur: 6 }));
  assert.equal(offense.state.phase, 'done', 'an offensive foul does not extend the game');
});

test('overtime: both teams get a possession, then the next score wins', () => {
  const ot = { ...at({ qtr: 5, clock: 600, score: [20, 20], to: [2, 2] }), ot: { done: [0, 0] }, warned: false };
  // KC (1) scores a touchdown on the first possession: try, then NO gets the ball.
  const td = applySnap({ ...ot, yl: 5 }, play({ gain: 5, td: true })).state;
  assert.equal(td.phase, 'pat');
  const xp = applyTry(td, { two: false, good: true });
  assert.equal(xp.phase, 'kickoff');
  assert.deepEqual(xp.ot.done, [0, 1]);
  // NO answers with a touchdown: down 1, so it tries; the extra point ties it.
  const answer = applySnap({ ...applyKickoff(xp, { recvYl: 65, dur: 0 }), yl: 3 }, play({ gain: 3, td: true })).state;
  assert.equal(answer.phase, 'pat');
  const tied = applyTry(answer, { two: false, good: true });
  assert.equal(tied.phase, 'kickoff', 'tied after both possessions: sudden death');
  // Next score wins: a field goal by KC.
  const kc = applyKickoff(tied, { recvYl: 65, dur: 0 });
  const fg = applyFieldGoal({ ...kc, yl: 20 }, { made: true, dur: 5 });
  assert.equal(fg.phase, 'done');
  assert.equal(fg.winner, 1);
});

test('overtime: field goal, then a touchdown ends it at once', () => {
  const ot = { ...at({ qtr: 5, clock: 600, score: [20, 20] }), ot: { done: [0, 0] } };
  const fg = applyFieldGoal({ ...ot, yl: 20 }, { made: true, dur: 5 });
  assert.equal(fg.phase, 'kickoff');
  const no = applyKickoff(fg, { recvYl: 65, dur: 0 });
  assert.equal(no.pos, 0);
  const td = applySnap({ ...no, yl: 10 }, play({ gain: 10, td: true })).state;
  assert.equal(td.phase, 'done', 'no try: the touchdown wins it');
  assert.equal(td.winner, 0);
  const stop = applyPunt({ ...no, yl: 60, down: 4 }, { recvYl: 80, dur: 9 });
  assert.equal(stop.phase, 'done', 'the second possession ends without a score while behind');
  assert.equal(stop.winner, 1);
});

test('overtime: a defensive score or a safety on the first possession ends it', () => {
  const ot = { ...at({ qtr: 5, clock: 600, score: [20, 20] }), ot: { done: [0, 0] } };
  const six = applySnap(ot, play({ tov: true, defYl: 0, defTd: true })).state;
  assert.equal(six.phase, 'done');
  assert.equal(six.winner, 0);
  const safety = applySnap({ ...ot, yl: 98 }, play({ gain: -4, safety: true })).state;
  assert.equal(safety.phase, 'done');
  assert.equal(safety.winner, 0);
  const pick = applySnap(ot, play({ tov: true, defYl: 40 })).state;
  assert.equal(pick.phase, 'snap', 'a turnover without a score: the other team gets its possession');
  assert.deepEqual(pick.ot.done, [0, 1]);
});

test('overtime periods: regular season ends tied, playoffs continue', () => {
  const reg = cloneState({ ...at({ qtr: 5, clock: 0, score: [20, 20] }), ot: { done: [1, 1] } });
  endPeriodDraft(reg);
  assert.equal(reg.phase, 'done');
  assert.equal(reg.winner, -1);
  const po = cloneState({ ...at({ qtr: 5, clock: 0, score: [20, 20], playoff: true }), ot: { done: [1, 1] } });
  endPeriodDraft(po);
  assert.equal(po.qtr, 6);
  assert.equal(po.clock, 900);
  assert.equal(po.phase, 'snap');
  const po2 = cloneState({ ...po, qtr: 6, clock: 0, to: [0, 1] });
  endPeriodDraft(po2);
  assert.equal(po2.qtr, 7);
  assert.deepEqual(po2.to, [3, 3], 'timeouts reset at the start of the third overtime period');
  const playoffStart = preSnapRunoff(at({ clock: 5, running: true, score: [20, 20], playoff: true }), 30, 0.7).state;
  assert.equal(playoffStart.clock, 900);
  assert.deepEqual(playoffStart.to, [3, 3]);
  assert.equal(playoffStart.kicker, 0, 'away won the toss and receives');
});

test('helpers and display text', () => {
  const s = at({ qtr: 4, clock: 118.3, down: 3, ytg: 4, yl: 35 });
  assert.equal(clockText(s), 'Q4 1:59');
  assert.equal(downText(s), '3rd & 4');
  assert.equal(downText({ ...s, ytg: 5, yl: 5 }), '3rd & Goal');
  assert.equal(ballText(s), 'NO 35');
  assert.equal(ballText({ ...s, yl: 75 }), 'KC 25');
  assert.equal(clockText({ ...s, qtr: 5, clock: 600 }), 'OT 10:00');
  assert.equal(halfSeconds({ ...s, qtr: 3, clock: 100 }), 1000);
  assert.equal(marginFor(s, 1), -3);
  assert.equal(inStopWindow({ qtr: 3 }, 100), false);
});
