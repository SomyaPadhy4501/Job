'use strict';

/**
 * Postgres backend for src/db/index.js.
 * Activated when DATABASE_URL env var is set.
 * Exports the same API as src/db/sqlite.js — all functions return Promises.
 *
 * Schema: run migrations/001_init.sql once against Neon before deploying.
 * No programmatic migrations here — additive migrations go into new .sql files.
 */

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon requires SSL in production; allow self-signed certs on dev branches.
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 5,              // serverless: keep pool small
    idleTimeoutMillis: 10_000,
    // Neon free tier auto-suspends; cold-start can take 10s+ on first hit.
    connectionTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg] pool error', err.message);
  });
  return pool;
}

// Convenience: returns the pool (mirrors getDb() on the SQLite backend).
function getDb() {
  return getPool();
}

// ISO timestamp helper — avoids importing from config.
function now() {
  return new Date().toISOString();
}

/**
 * Upsert a single normalised job row.
 * `client` is an optional pg.PoolClient for use inside a transaction.
 * Returns { inserted: 0|1, updated: 0|1 }.
 */
async function upsertJob(job, client) {
  const db = client || getPool();

  // Primary lookup: dedupe_key
  const { rows: byKey } = await db.query(
    'SELECT id FROM jobs WHERE dedupe_key = $1',
    [job.dedupe_key],
  );
  let existing = byKey[0];

  // Secondary lookup: same apply_url under a different dedupe_key
  if (!existing && job.apply_url) {
    const { rows: byUrl } = await db.query(
      'SELECT id FROM jobs WHERE apply_url = $1 LIMIT 1',
      [job.apply_url],
    );
    existing = byUrl[0];
  }

  if (existing) {
    await db.query(
      `UPDATE jobs
         SET last_seen_at   = $1,
             apply_url      = $2,
             description    = $3,
             location       = $4,
             date_posted    = COALESCE($5, date_posted),
             sponsorship    = $6,
             role_type      = $7,
             category       = $8,
             is_entry_level = $9,
             is_mid_level   = $10
       WHERE id = $11`,
      [
        now(),
        job.apply_url,
        job.description,
        job.location,
        job.date_posted,
        job.sponsorship,
        job.role_type,
        job.category,
        job.is_entry_level,
        job.is_mid_level,
        existing.id,
      ],
    );
    return { inserted: 0, updated: 1 };
  }

  const ts = now();
  await db.query(
    `INSERT INTO jobs
       (dedupe_key, source, external_id, company_name, job_title, location,
        apply_url, description, date_posted, sponsorship, role_type, category,
        is_entry_level, is_mid_level, first_seen_at, last_seen_at)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
    [
      job.dedupe_key,
      job.source,
      job.external_id,
      job.company_name,
      job.job_title,
      job.location,
      job.apply_url,
      job.description,
      job.date_posted,
      job.sponsorship,
      job.role_type,
      job.category,
      job.is_entry_level,
      job.is_mid_level,
      ts,
    ],
  );
  return { inserted: 1, updated: 0 };
}

/**
 * Bulk-upsert an array of normalised rows in a single transaction.
 * Returns { inserted, updated }.
 */
async function bulkUpsert(rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  const client = await getPool().connect();
  let inserted = 0;
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const r = await upsertJob(row, client);
      inserted += r.inserted;
      updated += r.updated;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated };
}

async function pruneStaleJobs(days) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rowCount } = await getPool().query(
    `DELETE FROM jobs
      WHERE (date_posted IS NOT NULL AND date_posted < $1)
         OR (date_posted IS NULL     AND first_seen_at < $1)`,
    [cutoff],
  );
  return rowCount;
}

async function startRun() {
  const { rows } = await getPool().query(
    `INSERT INTO collection_runs (started_at) VALUES ($1) RETURNING id`,
    [now()],
  );
  return Number(rows[0].id);
}

async function finishRun(id, stats) {
  await getPool().query(
    `UPDATE collection_runs
        SET finished_at    = $1,
            companies_ok   = $2,
            companies_fail = $3,
            jobs_inserted  = $4,
            jobs_updated   = $5,
            errors         = $6
      WHERE id = $7`,
    [
      now(),
      stats.companies_ok,
      stats.companies_fail,
      stats.jobs_inserted,
      stats.jobs_updated,
      stats.errors ? JSON.stringify(stats.errors) : null,
      id,
    ],
  );
}

async function queryJobs({ search, title, sponsorship, company, role, level, source, limit, offset }) {
  const clauses = [];
  const params = [];
  let idx = 1;

  if (search) {
    clauses.push(`LOWER(company_name) LIKE $${idx++}`);
    params.push(`%${search.toLowerCase()}%`);
  }
  if (title) {
    clauses.push(`LOWER(job_title) LIKE $${idx++}`);
    params.push(`%${title.toLowerCase()}%`);
  }
  if (sponsorship) {
    clauses.push(`sponsorship = $${idx++}`);
    params.push(sponsorship);
  }
  if (company) {
    clauses.push(`LOWER(company_name) = $${idx++}`);
    params.push(company.toLowerCase());
  }
  if (role) {
    clauses.push(`role_type = $${idx++}`);
    params.push(role);
  }
  if (source) {
    clauses.push(`source = $${idx++}`);
    params.push(source);
  }
  if (level === 'entry')  clauses.push('is_entry_level = 1');
  else if (level === 'mid') clauses.push('is_mid_level = 1');
  else if (level === 'early') clauses.push('(is_entry_level = 1 OR is_mid_level = 1)');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // COUNT query (same params, no limit/offset)
  const { rows: [{ c }] } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM jobs ${where}`,
    params,
  );

  // Data query
  const dataParams = [...params, limit, offset];
  const limitIdx = idx++;
  const offsetIdx = idx++;
  const { rows } = await getPool().query(
    `SELECT id, source, company_name, job_title, location, apply_url,
            date_posted, sponsorship, role_type, category,
            is_entry_level, is_mid_level,
            first_seen_at, last_seen_at
       FROM jobs
       ${where}
      ORDER BY
        CASE WHEN date_posted IS NULL THEN 1 ELSE 0 END,
        date_posted DESC,
        first_seen_at DESC,
        id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataParams,
  );

  return { total: c, rows };
}

async function getJobById(id) {
  const { rows } = await getPool().query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function statsSummary() {
  const db = getPool();
  const [
    { rows: [{ c: total }] },
    { rows: bySponsor },
    { rows: byRole },
    { rows: bySource },
    { rows: [{ c: entryLevel }] },
    { rows: [{ c: midLevel }] },
    { rows: lastRunRows },
  ] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS c FROM jobs'),
    db.query('SELECT sponsorship, COUNT(*)::int AS c FROM jobs GROUP BY sponsorship'),
    db.query('SELECT role_type, COUNT(*)::int AS c FROM jobs GROUP BY role_type ORDER BY c DESC'),
    db.query('SELECT source, COUNT(*)::int AS c FROM jobs GROUP BY source ORDER BY c DESC'),
    db.query('SELECT COUNT(*)::int AS c FROM jobs WHERE is_entry_level = 1'),
    db.query('SELECT COUNT(*)::int AS c FROM jobs WHERE is_mid_level = 1'),
    db.query('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1'),
  ]);

  return {
    total,
    entryLevel,
    midLevel,
    bySponsor,
    byRole,
    bySource,
    lastRun: lastRunRows[0] || null,
  };
}

module.exports = {
  getDb,
  upsertJob,
  bulkUpsert,
  startRun,
  finishRun,
  queryJobs,
  getJobById,
  statsSummary,
  pruneStaleJobs,
};
