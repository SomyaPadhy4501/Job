-- migrations/010_workday_login.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/010_workday_login.sql
--
-- Workday login: the one email and password a user sets on the Autofill page
-- (crates/api/src/workday_login.rs) for every company's Workday site. The
-- website only ever sees the email and when it was saved; the extension reads
-- both with its bearer token (GET /api/autofill/workday-login) to sign in and
-- to fill the create-account form.
--
-- APPLY THIS BEFORE DEPLOYING THE WORKDAY LOGIN ROUTES. While the table is
-- missing those routes answer 503 and everything else keeps working.
--
-- Additive and idempotent, one transaction. Safe to re-run.
--
-- Stored in the clear: when it was last saved. Encrypted by the application
-- (BYTEA column marked "encrypted"): `{email, password}` in `login_data`,
-- bound to the user id. Deleting the user deletes the row.

BEGIN;

CREATE TABLE IF NOT EXISTS workday_logins (
  user_id     UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  login_data  BYTEA       NOT NULL,                       -- encrypted
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
