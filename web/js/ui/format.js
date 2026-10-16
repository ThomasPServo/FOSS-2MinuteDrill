// Formatting helpers for clocks, downs, field position, percentages and dates.

const MINUS = '−';

/** Game clock "M:SS" from seconds (rounded up, so 0:00 only when time is really out). */
export function clock(secs) {
  const t = Math.max(0, Math.ceil(secs - 1e-6));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function ordinal(n) {
  return `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
}

/** "3rd & 4", "1st & Goal". */
export function downDistance(down, ytg, yl) {
  const d = ordinal(Math.min(Math.max(down, 1), 4));
  return ytg >= yl ? `${d} & Goal` : `${d} & ${Math.max(1, Math.round(ytg))}`;
}

/**
 * Field position in words from the user's side: "your 36", "their 35", "midfield".
 * `yl` is yards from the goal the offense attacks; `userHasBall` says whose that is.
 */
export function ballOn(yl, userHasBall) {
  const fromUserGoal = userHasBall ? 100 - yl : yl;
  const y = Math.round(fromUserGoal);
  if (y === 50) return 'midfield';
  return y < 50 ? `your ${Math.max(1, y)}` : `their ${Math.max(1, 100 - y)}`;
}

/** 0.483 -> "48%". */
export const pct = (p) => `${Math.round(p * 100)}%`;

/** 0.4834 -> "48.3%". */
export const pct1 = (p) => `${(p * 100).toFixed(1)}%`;

/** Signed number with a real minus sign: 2.14 -> "+2.1", -0.5 -> "−0.5". */
export function signed(x, digits = 1) {
  const v = Number(x.toFixed(digits));
  if (v === 0) return (0).toFixed(digits);
  return `${v > 0 ? '+' : MINUS}${Math.abs(v).toFixed(digits)}`;
}

/** Signed whole number: 7 -> "+7", -12 -> "−12". */
export const signedInt = (x) => (x > 0 ? `+${x}` : x < 0 ? `${MINUS}${-x}` : '0');

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The player's local calendar date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from date string a to date string b (both YYYY-MM-DD, calendar days). */
export function daysBetween(a, b) {
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(b) - t(a)) / 864e5);
}

/** "Oct 16" from YYYY-MM-DD. */
export function shortDate(date) {
  const d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const ROUNDS = { WC: 'Wild Card Round', DIV: 'Divisional Round', CON: 'Conference Championship', SB: 'Super Bowl' };

/** "2024 · Week 5" or "2025 · Divisional Round". */
export function gameTag(season, week, type) {
  return `${season} · ${ROUNDS[type] || `Week ${week}`}`;
}

/** "J. Allen" from a player object ({short} or {name}). */
export function shortName(p) {
  if (!p) return '';
  if (p.short) return p.short.replace(/^(\w+)\.(?=\S)/, '$1. ');
  const parts = String(p.name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : parts[0] || '';
}

/** Last name of a coach or player. */
export const lastName = (name) => String(name || '').trim().split(/\s+/).slice(-1)[0];

/** Yards per second (the data's speed unit) to miles per hour, one decimal. */
export const mph = (ydPerSec) => Math.round(ydPerSec * 3600 / 1760 * 10) / 10;
