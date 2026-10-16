// Persistence in localStorage under one prefix. Every access is wrapped: with storage
// disabled (private mode, blocked cookies) the game keeps working from an in-memory copy.

const PREFIX = 'foss2md:v1:';
const memory = new Map();

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw != null) return JSON.parse(raw);
  } catch {
    // storage unavailable or corrupt: use the in-memory copy
  }
  return memory.has(key) ? structuredClone(memory.get(key)) : fallback;
}

export function save(key, value) {
  memory.set(key, structuredClone(value));
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // nothing to do
  }
}

/** A random device token (32 hex chars), made once; only ever sent to a configured board. */
export function deviceToken() {
  let token = load('token');
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    save('token', token);
  }
  return token;
}

// --- named records -------------------------------------------------------------------------

/** Daily state for a local date: { spotId, started, game, log, last, done, end }. */
export const loadDay = (date) => load(`day:${date}`);
export const saveDay = (date, day) => save(`day:${date}`, day);

/** Daily history: { days: { [date]: { p, coach, vsTypical, result, team, squares, day } } }. */
export const loadHistory = () => load('stats', { days: {} });
export const saveHistory = (h) => save('stats', h);

/** Survivor run in progress (or finished, until a new run starts). */
export const loadRun = () => load('surv');
export const saveRun = (run) => save('surv', run);

/** Survivor totals: { runs, best }. */
export const loadRunStats = () => load('survstats', { runs: 0, best: 0 });
export const saveRunStats = (s) => save('survstats', s);

export const loadName = () => load('name', '');
export const saveName = (name) => save('name', name);

export const helpSeen = () => load('seen', false);
export const markHelpSeen = () => save('seen', true);
