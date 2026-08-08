-- migrations/003_add_yoe_min.sql
-- Run once against Neon: psql $DATABASE_URL -f migrations/003_add_yoe_min.sql
--
-- Adds `yoe_min`: the lowest years-of-experience figure stated in the posting,
-- extracted by src/services/experience.js.
--
--   -1  the posting states no number  (distinct from 0 — don't collapse them)
--    0  explicitly no experience required / new grad
--   N   "N+ years", or the low end of "N-M years"
--
-- Feeds is_entry_level / is_mid_level, which were previously title-only and
-- left 1,229 of 1,731 rows unlabelled.
--
-- RUN THIS BEFORE DEPLOYING THE CODE — queryJobs selects an explicit column
-- list, so shipping code first makes every /jobs request 500 in production.
--
-- Additive and idempotent. ADD COLUMN with a constant default is catalog-only
-- in Postgres 11+, so no table rewrite.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS yoe_min INTEGER NOT NULL DEFAULT -1;
