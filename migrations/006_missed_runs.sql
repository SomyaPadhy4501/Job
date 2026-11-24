-- migrations/006_missed_runs.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/006_missed_runs.sql
--
-- Adds `missed_runs`: how many successful collect runs in a row listed this
-- row's company in full and didn't list this row. At 2 the posting is taken as
-- closed and the row is deleted (src/services/closed.js). Any sighting resets
-- it to 0.
--
-- Order doesn't matter for this one: only the closed-job step reads the
-- column, and until it exists that step logs `closed.skipped` and does
-- nothing. Upserts and /jobs never touch it.
--
-- Additive and idempotent. ADD COLUMN with a constant default is catalog-only
-- in Postgres 11+, so no table rewrite.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS missed_runs INTEGER NOT NULL DEFAULT 0;
