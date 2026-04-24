'use strict';

/**
 * DB backend router.
 * - DATABASE_URL set → Postgres (production on Neon via Vercel + GitHub Actions)
 * - DATABASE_URL unset → SQLite  (local dev via ./run-all.sh)
 *
 * Both backends export the identical async API:
 *   getDb, upsertJob, bulkUpsert, startRun, finishRun,
 *   queryJobs, getJobById, statsSummary, pruneStaleJobs
 */
module.exports = process.env.DATABASE_URL
  ? require('./pg')
  : require('./sqlite');
