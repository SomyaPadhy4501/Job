-- migrations/009_gmail_connections.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/009_gmail_connections.sql
--
-- Connectors: a user's read-only Gmail grant, connected from Settings ->
-- Connectors (crates/api/src/connectors.rs). The extension asks the server
-- for the one code or Workday verify link it needs; the server reads Gmail
-- with this grant and hands back nothing else.
--
-- APPLY THIS BEFORE DEPLOYING THE CONNECTOR ROUTES. While the table is
-- missing those routes answer 503 and everything else keeps working.
--
-- Additive and idempotent, one transaction. Safe to re-run.
--
-- Stored in the clear: the granted scopes and when the grant was made and
-- last used. Encrypted by the application (BYTEA columns marked
-- "encrypted"): the Google account (sub, email) and refresh token in
-- `grant_data`, and the short-lived access token with its expiry in
-- `access_data`. Deleting the user deletes the row; the API revokes the
-- grant at Google first.

BEGIN;

CREATE TABLE IF NOT EXISTS gmail_connections (
  user_id       UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  grant_data    BYTEA       NOT NULL,                       -- encrypted
  access_data   BYTEA,                                      -- encrypted
  scopes        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

COMMIT;
