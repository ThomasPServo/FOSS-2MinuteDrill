// Optional leaderboard for FOSS 2-Minute Drill: a Cloudflare Worker backed by a D1 (SQLite)
// database. The game works without it; set <meta name="board-api"> in web/index.html to the
// worker's URL to turn the daily ranks and the survivor board on.
//
// What is stored: the date, the score, whether the game was won, an optional display name,
// and a salted SHA-256 of a random token the browser made up (so one device counts once a day
// and nobody else can take its name). No IP addresses, emails or real names.
//
//   GET  /daily?date=YYYY-MM-DD   -> { date, n, wins, mean, hist[10], top[] }
//   POST /daily    { date, token, score, win, name? }   -> the same summary plus your rank
//   GET  /survivor                -> { top[] }
//   POST /survivor { token, name, streak }              -> { top[], best }

const MAX_NAME = 20;
const TOP_N = 25;

const json = (body, status = 200, origin = '*') => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  },
});

export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const s = name.normalize('NFKC').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s || null;
}

export function validDate(date, now = new Date()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // accept yesterday through tomorrow (UTC) so every time zone can post its own "today"
  const day = 86400000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return t >= today - day && t <= today + day;
}

async function hashToken(token, salt) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const data = new TextEncoder().encode(`${salt}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function dailySummary(db, date) {
  const agg = await db.prepare(
    'SELECT COUNT(*) AS n, SUM(win) AS wins, AVG(score) AS mean FROM daily WHERE date = ?1',
  ).bind(date).first();
  const bins = await db.prepare(
    'SELECT MIN(CAST(score / 10 AS INTEGER), 9) AS b, COUNT(*) AS c FROM daily WHERE date = ?1 GROUP BY b',
  ).bind(date).all();
  const hist = new Array(10).fill(0);
  for (const row of bins.results || []) hist[row.b] = row.c;
  const top = await db.prepare(
    'SELECT name, score, win FROM daily WHERE date = ?1 AND name IS NOT NULL ORDER BY score DESC, ts ASC LIMIT ?2',
  ).bind(date, TOP_N).all();
  return {
    date,
    n: agg?.n || 0,
    wins: agg?.wins || 0,
    mean: agg?.mean == null ? null : Math.round(agg.mean * 10) / 10,
    hist,
    top: top.results || [],
  };
}

async function survivorTop(db) {
  const top = await db.prepare('SELECT name, best FROM survivor ORDER BY best DESC, ts ASC LIMIT ?1').bind(TOP_N).all();
  return top.results || [];
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    if (request.method === 'OPTIONS') return json({}, 204, origin);
    const url = new URL(request.url);
    const db = env.DB;
    const salt = env.TOKEN_SALT || 'change-me';
    try {
      if (url.pathname === '/daily' && request.method === 'GET') {
        const date = url.searchParams.get('date');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json({ error: 'bad date' }, 400, origin);
        return json(await dailySummary(db, date), 200, origin);
      }
      if (url.pathname === '/daily' && request.method === 'POST') {
        const body = await request.json();
        const score = Number(body.score);
        if (!validDate(body.date)) return json({ error: 'bad date' }, 400, origin);
        if (!Number.isFinite(score) || score < 0 || score > 100) return json({ error: 'bad score' }, 400, origin);
        const id = await hashToken(body.token, salt);
        if (!id) return json({ error: 'bad token' }, 400, origin);
        // the first finish of the day counts; later posts can only add a name
        await db.prepare(
          `INSERT INTO daily (date, id, name, score, win, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (date, id) DO UPDATE SET name = COALESCE(daily.name, excluded.name)`,
        ).bind(body.date, id, cleanName(body.name), Math.round(score * 10) / 10, body.win ? 1 : 0, Date.now()).run();
        const mine = await db.prepare('SELECT score FROM daily WHERE date = ?1 AND id = ?2').bind(body.date, id).first();
        const better = await db.prepare('SELECT COUNT(*) AS c FROM daily WHERE date = ?1 AND score > ?2')
          .bind(body.date, mine.score).first();
        return json({ ...(await dailySummary(db, body.date)), rank: (better?.c || 0) + 1, score: mine.score }, 200, origin);
      }
      if (url.pathname === '/survivor' && request.method === 'GET') {
        return json({ top: await survivorTop(db) }, 200, origin);
      }
      if (url.pathname === '/survivor' && request.method === 'POST') {
        const body = await request.json();
        const streak = Math.trunc(Number(body.streak));
        const name = cleanName(body.name);
        if (!Number.isFinite(streak) || streak < 0 || streak > 1000) return json({ error: 'bad streak' }, 400, origin);
        if (!name) return json({ error: 'a name is needed for the board' }, 400, origin);
        const id = await hashToken(body.token, salt);
        if (!id) return json({ error: 'bad token' }, 400, origin);
        await db.prepare(
          `INSERT INTO survivor (id, name, best, ts) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name,
             ts = CASE WHEN excluded.best > survivor.best THEN excluded.ts ELSE survivor.ts END,
             best = MAX(survivor.best, excluded.best)`,
        ).bind(id, name, streak, Date.now()).run();
        const mine = await db.prepare('SELECT best FROM survivor WHERE id = ?1').bind(id).first();
        return json({ top: await survivorTop(db), best: mine.best }, 200, origin);
      }
      return json({ error: 'not found' }, 404, origin);
    } catch (err) {
      return json({ error: 'server error' }, 500, origin);
    }
  },
};
