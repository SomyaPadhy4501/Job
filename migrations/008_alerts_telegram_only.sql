-- migrations/008_alerts_telegram_only.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/008_alerts_telegram_only.sql
--
-- Job alerts go to Telegram only; email alerts were removed
-- (crates/api/src/alerts.rs). New alerts default to Telegram, existing ones
-- lose 'email', and an alert left with no channel gets Telegram so it still
-- sends once its owner links a chat. The email quota counters go too.
--
-- Idempotent, one transaction. Safe to re-run.

BEGIN;

ALTER TABLE job_alerts ALTER COLUMN channels SET DEFAULT '{telegram}';

UPDATE job_alerts
   SET channels = CASE
         WHEN cardinality(array_remove(channels, 'email')) = 0 THEN '{telegram}'::TEXT[]
         ELSE array_remove(channels, 'email')
       END,
       updated_at = now()
 WHERE 'email' = ANY (channels) OR cardinality(channels) = 0;

DELETE FROM usage_counters WHERE subject = 'global' AND bucket = 'alert_email';

COMMIT;
