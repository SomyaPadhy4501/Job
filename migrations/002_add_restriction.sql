-- migrations/002_add_restriction.sql
-- Run once against Neon: psql $DATABASE_URL -f migrations/002_add_restriction.sql
--
-- Adds `restriction`: why a posting is closed to a candidate who needs visa
-- sponsorship. Values are produced by src/services/clearance.js:
--
--   'CLEARANCE'            hard security-clearance requirement       (blocking)
--   'EXPORT_CONTROL'       ITAR / EAR "U.S. person" requirement      (blocking)
--   'CITIZENSHIP'          explicit US-citizens-only requirement     (blocking)
--   'EXPORT_ADVISORY'      export control named, no personal bar     (advisory)
--   'CLEARANCE_PREFERRED'  clearance "a plus", not required          (advisory)
--   ''                     no restriction signal
--
-- RUN THIS BEFORE DEPLOYING THE CODE. queryJobs selects an explicit column
-- list, so shipping the code first makes every /jobs request 500 in production
-- while local SQLite (which self-migrates at boot) looks fine.
--
-- Additive and idempotent: safe to re-run, and a no-op on a database created
-- from the updated 001_init.sql. ADD COLUMN with a non-volatile default is a
-- catalog-only change in Postgres 11+ — no table rewrite.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS restriction TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_jobs_restriction ON jobs (restriction);
