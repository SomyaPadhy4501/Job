-- migrations/007_alerts.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/007_alerts.sql
--
-- Job alerts (email and Telegram), linked chats, and the apply queue behind
-- the Rust /api function (crates/api/src/alerts.rs, chat.rs, queue.rs). Only
-- the Rust code reads these tables; `jobs` is only read, never changed.
--
-- APPLY THIS BEFORE DEPLOYING THE ALERT ROUTES. While the tables are missing
-- those routes answer 503 and everything else keeps working.
--
-- Additive and idempotent, one transaction. Safe to re-run.
--
-- Stored in the clear: how often an alert runs and where it goes, when it
-- last ran, which public job ids it already sent, and the public company,
-- title and link of each queued job. Encrypted by the application (BYTEA
-- columns marked "encrypted"): the alert's name and filters, the chat id, and
-- notes on queued jobs. A chat is found by a keyed hash of its id, so this
-- table alone can't tell whose chat is whose.

BEGIN;

-- One saved search. `spec` (encrypted) holds the name and the board's own
-- filters: role, level, sponsorship, restriction, companies, keywords,
-- locations. `last_run_at` is the watermark: the next run looks at jobs first
-- seen after it.
CREATE TABLE IF NOT EXISTS job_alerts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  spec         BYTEA       NOT NULL,                       -- encrypted
  frequency    TEXT        NOT NULL CHECK (frequency IN ('instant', 'daily', 'weekly')),
  channels     TEXT[]      NOT NULL DEFAULT '{email}',
  paused       BOOLEAN     NOT NULL DEFAULT FALSE,
  last_run_at  TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_alerts_user ON job_alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_job_alerts_due  ON job_alerts (last_run_at) WHERE NOT paused;

-- Jobs an alert already sent, so a job is never sent twice by one alert.
-- `jobs.id` is not a foreign key: closed jobs are deleted from `jobs`, and
-- this row should simply age out (the alert run drops rows over 30 days).
CREATE TABLE IF NOT EXISTS alert_sent_jobs (
  alert_id  UUID        NOT NULL REFERENCES job_alerts (id) ON DELETE CASCADE,
  job_id    INTEGER     NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_sent_jobs_sent ON alert_sent_jobs (sent_at);

-- A chat (Telegram now; WhatsApp could be added later) linked to an account.
-- `address_hash` is HMAC(key, channel || chat id), for finding the account
-- when a message arrives; `address` (encrypted) is the chat id itself, for
-- sending.
CREATE TABLE IF NOT EXISTS chat_links (
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel       TEXT        NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  address_hash  BYTEA       NOT NULL CHECK (octet_length(address_hash) = 32),
  address       BYTEA       NOT NULL,                      -- encrypted
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel),
  UNIQUE (channel, address_hash)
);

-- One-time codes shown on the Alerts page and sent to the bot to link a chat.
-- Stored hashed; 15 minutes; one live code per user and channel.
CREATE TABLE IF NOT EXISTS chat_link_codes (
  code_hash   BYTEA       PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel     TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, channel)
);

-- Jobs the user wants to apply to. Company, title and link are copied from
-- `jobs` (public data) so an item outlives the job row. Nobody but the user
-- moves an item to 'submitted_by_you'; an agent stops at 'prepared'.
CREATE TABLE IF NOT EXISTS apply_queue (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  job_id      INTEGER     NOT NULL,
  company     TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  apply_url   TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'prepared', 'needs_you', 'submitted_by_you', 'skipped')),
  note        BYTEA,                                       -- encrypted
  added_via   TEXT        NOT NULL DEFAULT 'web',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_apply_queue_user ON apply_queue (user_id, updated_at DESC);

-- Every change to a queue item, by whom: 'you' (the web page), 'telegram',
-- 'extension' or 'agent'. No personal data: ids, statuses and when.
CREATE TABLE IF NOT EXISTS apply_events (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id      UUID        NOT NULL,
  actor        TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apply_events_item ON apply_events (user_id, item_id, created_at DESC);

-- New jobs since a watermark: the alert run's main query.
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs (first_seen_at);

COMMIT;
