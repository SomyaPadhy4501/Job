'use strict';

/**
 * DB backend router.
 * - DATABASE_URL set → Postgres (production on Neon via Vercel + GitHub Actions)
 * - DATABASE_URL unset → SQLite  (local dev via ./run-all.sh)
 *
 * Both backends export the identical async API:
 *   getDb, upsertJob, bulkUpsert, startRun, finishRun,
 *   queryJobs, getJobById, statsSummary, pruneStaleJobs, pruneUnseenJobs,
 *   pruneOverExperienced, pruneIneligible
 *
 * SQLite's functions are synchronous and Postgres's return promises, so callers
 * must `await` every one of them — awaiting a plain value is harmless.
 */
module.exports = process.env.DATABASE_URL
  ? require('./pg')
  : require('./sqlite');
