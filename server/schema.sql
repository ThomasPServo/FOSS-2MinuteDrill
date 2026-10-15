-- D1 schema for the optional leaderboard (server/worker.js).
-- Apply with: npx wrangler d1 execute <db-name> --file server/schema.sql

CREATE TABLE IF NOT EXISTS daily (
  date  TEXT    NOT NULL,          -- YYYY-MM-DD, the player's local date of the daily spot
  id    TEXT    NOT NULL,          -- salted SHA-256 of the browser's random token
  name  TEXT,                      -- optional display name
  score REAL    NOT NULL,          -- percentile against simulated NFL play-callers, 0-100
  win   INTEGER NOT NULL DEFAULT 0,
  ts    INTEGER NOT NULL,          -- ms since epoch of the first finish
  PRIMARY KEY (date, id)
);
CREATE INDEX IF NOT EXISTS daily_date_score ON daily (date, score DESC);

CREATE TABLE IF NOT EXISTS survivor (
  id    TEXT    PRIMARY KEY,
  name  TEXT    NOT NULL,
  best  INTEGER NOT NULL,          -- longest run of games won
  ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS survivor_best ON survivor (best DESC);
