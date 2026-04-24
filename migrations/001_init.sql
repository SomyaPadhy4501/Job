-- migrations/001_init.sql
-- Run once against Neon: psql $DATABASE_URL -f migrations/001_init.sql
-- Mirrors the SQLite schema in src/db/index.js exactly.

CREATE TABLE IF NOT EXISTS jobs (
  id             SERIAL PRIMARY KEY,
  dedupe_key     TEXT    NOT NULL UNIQUE,
  source         TEXT    NOT NULL,
  external_id    TEXT,
  company_name   TEXT    NOT NULL,
  job_title      TEXT    NOT NULL,
  location       TEXT,
  apply_url      TEXT    NOT NULL,
  description    TEXT,
  date_posted    TEXT,
  sponsorship    TEXT    NOT NULL DEFAULT 'UNKNOWN',
  role_type      TEXT    NOT NULL DEFAULT 'OTHER',
  category       TEXT    NOT NULL DEFAULT 'SMALL',
  is_entry_level SMALLINT NOT NULL DEFAULT 0,
  is_mid_level   SMALLINT NOT NULL DEFAULT 0,
  first_seen_at  TEXT    NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  last_seen_at   TEXT    NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

CREATE INDEX IF NOT EXISTS idx_jobs_company   ON jobs (company_name);
CREATE INDEX IF NOT EXISTS idx_jobs_sponsor   ON jobs (sponsorship);
CREATE INDEX IF NOT EXISTS idx_jobs_title     ON jobs (job_title);
CREATE INDEX IF NOT EXISTS idx_jobs_posted    ON jobs (date_posted);
CREATE INDEX IF NOT EXISTS idx_jobs_role      ON jobs (role_type);
CREATE INDEX IF NOT EXISTS idx_jobs_entry     ON jobs (is_entry_level);
CREATE INDEX IF NOT EXISTS idx_jobs_applyurl  ON jobs (apply_url);
CREATE INDEX IF NOT EXISTS idx_jobs_category  ON jobs (category);

CREATE TABLE IF NOT EXISTS collection_runs (
  id              SERIAL PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  finished_at     TEXT,
  companies_ok    INTEGER NOT NULL DEFAULT 0,
  companies_fail  INTEGER NOT NULL DEFAULT 0,
  jobs_inserted   INTEGER NOT NULL DEFAULT 0,
  jobs_updated    INTEGER NOT NULL DEFAULT 0,
  errors          TEXT
);
