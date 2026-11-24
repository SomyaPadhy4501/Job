-- migrations/005_resume_sources.sql
-- Run with migrate.yml (verify, then apply), or: psql $DATABASE_URL -v ON_ERROR_STOP=1 -f migrations/005_resume_sources.sql
--
-- LaTeX source for resumes made in the site's LaTeX editor, and cleanup of
-- a resume's old file when the editor replaces it.
--
-- Additive and idempotent (IF NOT EXISTS / OR REPLACE, one transaction).
-- Safe to re-run.

BEGIN;

-- One source per resume (encrypted: it holds everything the resume says).
-- `compiled_sha256` is the SHA-256 (hex) of the PDF the source was saved
-- with; when it differs from the resume's file, the PDF is out of date.
CREATE TABLE IF NOT EXISTS resume_sources (
  resume_id        UUID        PRIMARY KEY REFERENCES resumes (id) ON DELETE CASCADE,
  source           BYTEA       NOT NULL,   -- encrypted
  compiled_sha256  TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replacing a resume's file changes its object key: queue the old object for
-- deletion, the same way deleting the row does.
DROP TRIGGER IF EXISTS trg_resumes_queue_replaced_object ON resumes;
CREATE TRIGGER trg_resumes_queue_replaced_object
  AFTER UPDATE OF object_key ON resumes
  FOR EACH ROW
  WHEN (OLD.object_key IS DISTINCT FROM NEW.object_key)
  EXECUTE FUNCTION queue_resume_object_deletion();

COMMIT;
