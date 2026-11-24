-- migrations/004_accounts.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/004_accounts.sql
--
-- Accounts, resumes, profiles and the answer bank behind the Rust /api
-- function (crates/). Only the Rust code reads these tables: `jobs` and
-- `collection_runs` are untouched, and the Node backend never sees them.
--
-- APPLY THIS BEFORE DEPLOYING THE ACCOUNT ROUTES. While the tables are
-- missing they answer 503 and the public board keeps working.
--
-- Additive and idempotent: every statement is IF NOT EXISTS or OR REPLACE, and
-- the whole file is one transaction, so a failure part-way leaves nothing
-- behind. Safe to re-run.
--
-- What is stored in the clear: account email, name and avatar (shown when
-- signed in), resume titles, tags and file names, and timestamps.
-- Everything a user writes about themselves is encrypted by the application
-- before it gets here (AES-256-GCM, BYTEA columns marked "encrypted"). Each
-- value is bound to its table, column and owner, so a value copied into
-- another row fails to decrypt. Resume files live in object storage (R2),
-- never in Postgres.

BEGIN;

-- One row per Google account. Matched by `google_sub`, never by email:
-- Google lets people change their email, and `sub` never changes.
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      TEXT        NOT NULL UNIQUE,
  email           TEXT        NOT NULL,
  email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
  name            TEXT        NOT NULL DEFAULT '',
  avatar_url      TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ
);

-- Browser sessions. Only the SHA-256 of the cookie value is stored, so a copy
-- of this table can't be used to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  id_hash              BYTEA       PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  absolute_expires_at  TIMESTAMPTZ NOT NULL,
  user_agent           TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Tokens for the autofill extension. Shown once at creation, stored hashed;
-- `token_prefix` is the non-secret start of the token, so the settings page
-- can tell tokens apart.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    BYTEA       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  token_prefix  TEXT        NOT NULL,
  label         TEXT        NOT NULL DEFAULT '',
  scopes        TEXT[]      NOT NULL DEFAULT '{autofill}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id);

-- Resume files: metadata here, bytes in object storage under `object_key`.
-- An upload inserts the row as 'uploading' (the unique (user_id, sha256) pair
-- stops two concurrent uploads of the same file), puts the object, then marks
-- it 'stored'. Rows stuck in 'uploading' are swept.
CREATE TABLE IF NOT EXISTS resumes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title          TEXT        NOT NULL,
  tags           TEXT[]      NOT NULL DEFAULT '{}',
  is_default     BOOLEAN     NOT NULL DEFAULT FALSE,
  file_name      TEXT        NOT NULL,
  mime_type      TEXT        NOT NULL CHECK (mime_type IN (
                   'application/pdf',
                   'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes     INTEGER     NOT NULL CHECK (size_bytes > 0),
  sha256         BYTEA       NOT NULL CHECK (octet_length(sha256) = 32),
  object_key     TEXT        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'stored')),
  parse_status   TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (parse_status IN ('pending', 'parsed', 'no_text', 'failed')),
  parse_version  SMALLINT    NOT NULL DEFAULT 0,
  parsed         BYTEA,      -- encrypted: what the parser read from the file
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);
-- At most one default resume per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_resumes_one_default ON resumes (user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_resumes_uploading ON resumes (created_at) WHERE status = 'uploading';

-- The autofill profile (identity, contact, work authorization, education, ...).
-- `sources` records where each field came from ("user" or "resume:<id>"), so
-- importing a resume never overwrites what the user typed. `version` goes up
-- on every write; a write that names an older version is refused (409), so
-- the web app and the extension can't silently overwrite each other.
CREATE TABLE IF NOT EXISTS profiles (
  user_id     UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  data        BYTEA       NOT NULL,  -- encrypted
  sources     JSONB       NOT NULL DEFAULT '{}',
  version     INTEGER     NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved answers to application questions. The question, the company it is
-- scoped to and the answer are encrypted together in `entry`; `entry_key` is
-- a hash of (user, scope, company, normalized question), which finds an
-- existing answer to update without storing the question in the clear.
CREATE TABLE IF NOT EXISTS answers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entry_key   BYTEA       NOT NULL CHECK (octet_length(entry_key) = 32),
  scope       TEXT        NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'company')),
  entry       BYTEA       NOT NULL,  -- encrypted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_key)
);

-- Rate limits and quotas that must survive deletes (deleting a resume doesn't
-- give back today's upload). Subjects: 'user:<id>', 'ip:<sha256 of the IP>',
-- 'global'. Periods: 'YYYY-MM-DD' or 'YYYY-MM'. Old periods are pruned.
CREATE TABLE IF NOT EXISTS usage_counters (
  subject  TEXT   NOT NULL,
  bucket   TEXT   NOT NULL,
  period   TEXT   NOT NULL,
  count    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, bucket, period)
);

-- Security-relevant events, with no personal data: who (an opaque user id that
-- means nothing once the account is deleted), what, when. Kept 90 days.
CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     UUID,
  kind        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);

-- Object-storage keys whose rows are gone. Filled by the trigger below, which
-- also fires on cascades (account deletion), so no delete path can forget a
-- file. The API deletes the objects right after commit; a daily job retries
-- whatever is left.
CREATE TABLE IF NOT EXISTS object_deletions (
  object_key  TEXT        PRIMARY KEY,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts    INTEGER     NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE OR REPLACE FUNCTION queue_resume_object_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO object_deletions (object_key) VALUES (OLD.object_key)
  ON CONFLICT (object_key) DO NOTHING;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_resumes_queue_object_deletion ON resumes;
CREATE TRIGGER trg_resumes_queue_object_deletion
  AFTER DELETE ON resumes
  FOR EACH ROW EXECUTE FUNCTION queue_resume_object_deletion();

COMMIT;
