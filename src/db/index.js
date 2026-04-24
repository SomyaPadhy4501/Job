'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { CONFIG } = require('../config');

let db = null;

function getDb() {
  if (db) return db;
  const dbPath = path.resolve(CONFIG.dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  migrate(db);
  return db;
}

function initSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
      is_entry_level INTEGER NOT NULL DEFAULT 0,
      is_mid_level   INTEGER NOT NULL DEFAULT 0,
      first_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_company    ON jobs (company_name);
    CREATE INDEX IF NOT EXISTS idx_jobs_sponsor    ON jobs (sponsorship);
    CREATE INDEX IF NOT EXISTS idx_jobs_title      ON jobs (job_title);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted     ON jobs (date_posted);
    CREATE INDEX IF NOT EXISTS idx_jobs_role       ON jobs (role_type);
    CREATE INDEX IF NOT EXISTS idx_jobs_entry      ON jobs (is_entry_level);
    CREATE INDEX IF NOT EXISTS idx_jobs_applyurl   ON jobs (apply_url);

    CREATE TABLE IF NOT EXISTS collection_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      companies_ok    INTEGER NOT NULL DEFAULT 0,
      companies_fail  INTEGER NOT NULL DEFAULT 0,
      jobs_inserted   INTEGER NOT NULL DEFAULT 0,
      jobs_updated    INTEGER NOT NULL DEFAULT 0,
      errors          TEXT
    );
  `);
}

// Additive migrations for existing DBs created before these columns/indexes existed.
function migrate(database) {
  const cols = database.prepare("PRAGMA table_info(jobs)").all().map((r) => r.name);
  if (!cols.includes('role_type')) {
    database.exec("ALTER TABLE jobs ADD COLUMN role_type TEXT NOT NULL DEFAULT 'OTHER'");
    database.exec("CREATE INDEX IF NOT EXISTS idx_jobs_role ON jobs (role_type)");
  }
  if (!cols.includes('is_entry_level')) {
    database.exec('ALTER TABLE jobs ADD COLUMN is_entry_level INTEGER NOT NULL DEFAULT 0');
    database.exec('CREATE INDEX IF NOT EXISTS idx_jobs_entry ON jobs (is_entry_level)');
  }
  if (!cols.includes('is_mid_level')) {
    database.exec('ALTER TABLE jobs ADD COLUMN is_mid_level INTEGER NOT NULL DEFAULT 0');
    database.exec('CREATE INDEX IF NOT EXISTS idx_jobs_mid ON jobs (is_mid_level)');
  }
  // 2026-04-24: add apply_url index so upsertJob can do a secondary dedupe
  // lookup by URL (catches near-duplicates where the dedupe_key differs only
  // due to cosmetic drift — "Google LLC" vs "Google", "SF, CA, USA" vs "SF, CA").
  database.exec('CREATE INDEX IF NOT EXISTS idx_jobs_applyurl ON jobs (apply_url)');

  // One-shot cleanup: remove existing apply_url duplicates (keep oldest row).
  // No-op if the DB is already clean, so safe to run on every boot.
  const dupes = database
    .prepare('SELECT COUNT(*) AS c FROM (SELECT apply_url FROM jobs GROUP BY apply_url HAVING COUNT(*) > 1)')
    .get().c;
  if (dupes > 0) {
    const removed = database
      .prepare('DELETE FROM jobs WHERE id NOT IN (SELECT MIN(id) FROM jobs GROUP BY apply_url)')
      .run().changes;
    // eslint-disable-next-line no-console
    console.log(`[db.migrate] removed ${removed} apply_url duplicates across ${dupes} URLs`);
  }
}

function upsertJob(job) {
  const database = getDb();
  // Primary lookup: canonical dedupe_key. Catches the common case of re-seeing
  // the same role over time.
  let existing = database
    .prepare('SELECT id FROM jobs WHERE dedupe_key = ?')
    .get(job.dedupe_key);
  // Secondary lookup: same apply_url already exists under a different
  // dedupe_key. Happens when the same role is published by two sources with
  // slightly different company/title/location formatting ("Google LLC" vs
  // "Google", "SF, CA, USA" vs "San Francisco, California"). Merge them.
  if (!existing && job.apply_url) {
    existing = database
      .prepare('SELECT id FROM jobs WHERE apply_url = ? LIMIT 1')
      .get(job.apply_url);
  }

  if (existing) {
    database
      .prepare(
        `UPDATE jobs
         SET last_seen_at   = datetime('now'),
             apply_url      = @apply_url,
             description    = @description,
             location       = @location,
             date_posted    = COALESCE(@date_posted, date_posted),
             sponsorship    = @sponsorship,
             role_type      = @role_type,
             is_entry_level = @is_entry_level,
             is_mid_level   = @is_mid_level
         WHERE id = @id`
      )
      .run({ ...job, id: existing.id });
    return { inserted: 0, updated: 1 };
  }

  database
    .prepare(
      `INSERT INTO jobs
        (dedupe_key, source, external_id, company_name, job_title, location,
         apply_url, description, date_posted, sponsorship, role_type,
         is_entry_level, is_mid_level)
       VALUES
        (@dedupe_key, @source, @external_id, @company_name, @job_title, @location,
         @apply_url, @description, @date_posted, @sponsorship, @role_type,
         @is_entry_level, @is_mid_level)`
    )
    .run(job);
  return { inserted: 1, updated: 0 };
}

function startRun() {
  return getDb().prepare('INSERT INTO collection_runs DEFAULT VALUES').run().lastInsertRowid;
}

function finishRun(id, stats) {
  getDb()
    .prepare(
      `UPDATE collection_runs
       SET finished_at   = datetime('now'),
           companies_ok  = @companies_ok,
           companies_fail= @companies_fail,
           jobs_inserted = @jobs_inserted,
           jobs_updated  = @jobs_updated,
           errors        = @errors
       WHERE id = @id`
    )
    .run({ id, ...stats, errors: stats.errors ? JSON.stringify(stats.errors) : null });
}

function queryJobs({ search, sponsorship, company, role, level, limit, offset }) {
  const database = getDb();
  const clauses = [];
  const params = {};
  if (search) {
    clauses.push('(LOWER(job_title) LIKE @q OR LOWER(company_name) LIKE @q)');
    params.q = `%${search.toLowerCase()}%`;
  }
  if (sponsorship) {
    clauses.push('sponsorship = @sponsorship');
    params.sponsorship = sponsorship;
  }
  if (company) {
    clauses.push('LOWER(company_name) = @company');
    params.company = company.toLowerCase();
  }
  if (role) {
    clauses.push('role_type = @role');
    params.role = role;
  }
  // level: 'entry' → is_entry_level=1
  //        'mid'   → is_mid_level=1
  //        'early' → either entry OR mid (entry + 1-2 YOE bucket)
  //        ''      → any level that passed collection filters (i.e. not senior)
  if (level === 'entry') clauses.push('is_entry_level = 1');
  else if (level === 'mid') clauses.push('is_mid_level = 1');
  else if (level === 'early') clauses.push('(is_entry_level = 1 OR is_mid_level = 1)');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = database.prepare(`SELECT COUNT(*) AS c FROM jobs ${where}`).get(params).c;

  params.limit = limit;
  params.offset = offset;

  // Newest first. Rows with a known date_posted always come before rows
  // without one, so "no-date" Workday postings don't crowd out dated ones.
  // Within "no-date" rows, fall back to first_seen_at + id.
  const rows = database
    .prepare(
      `SELECT id, source, company_name, job_title, location, apply_url,
              date_posted, sponsorship, role_type,
              is_entry_level, is_mid_level,
              first_seen_at, last_seen_at
       FROM jobs
       ${where}
       ORDER BY
         CASE WHEN date_posted IS NULL THEN 1 ELSE 0 END,
         date_posted DESC,
         first_seen_at DESC,
         id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all(params);

  return { total, rows };
}

function getJobById(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function statsSummary() {
  const database = getDb();
  const total = database.prepare('SELECT COUNT(*) AS c FROM jobs').get().c;
  const bySponsor = database
    .prepare('SELECT sponsorship, COUNT(*) AS c FROM jobs GROUP BY sponsorship')
    .all();
  const byRole = database
    .prepare('SELECT role_type, COUNT(*) AS c FROM jobs GROUP BY role_type ORDER BY c DESC')
    .all();
  const bySource = database
    .prepare('SELECT source, COUNT(*) AS c FROM jobs GROUP BY source ORDER BY c DESC')
    .all();
  const entryLevel = database
    .prepare('SELECT COUNT(*) AS c FROM jobs WHERE is_entry_level = 1')
    .get().c;
  const midLevel = database
    .prepare('SELECT COUNT(*) AS c FROM jobs WHERE is_mid_level = 1')
    .get().c;
  const lastRun = database
    .prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1')
    .get();
  return { total, entryLevel, midLevel, bySponsor, byRole, bySource, lastRun };
}

module.exports = {
  getDb,
  upsertJob,
  startRun,
  finishRun,
  queryJobs,
  getJobById,
  statsSummary,
};
