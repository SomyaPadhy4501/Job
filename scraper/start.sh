#!/usr/bin/env bash
# Launcher for the Playwright scraper microservice.
#
# Isolation policy: this runs in its own Node process, pushes scraped jobs to
# the main app via HTTP, and is expected to break periodically. If it crashes,
# the main job board keeps serving whatever is already in the DB.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not installed" >&2
  exit 1
fi

# Install deps on first run (~300MB with Playwright + Chromium).
if [ ! -d node_modules ]; then
  echo "==> Installing scraper dependencies (first run, ~50 MB)..."
  npm install --no-audit --no-fund
fi

# Playwright needs its own browser download step.
if [ ! -d node_modules/playwright/.local-browsers ] && [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo "==> Downloading Chromium for Playwright (first run, ~250 MB)..."
  npx playwright install chromium
fi

: "${INGEST_URL:=http://localhost:4000/admin/ingest}"
: "${SCRAPER_CRON:=30 */6 * * *}"

cat <<EOF

============================================================
  Job Aggregator — Playwright Scraper
  Ingest URL  : $INGEST_URL
  Cron        : $SCRAPER_CRON  (runs once at startup)
  Targets     : ${SCRAPER_TARGETS:-microsoft,apple,meta,google}
  Stop        : Ctrl+C
============================================================

EOF

export INGEST_URL SCRAPER_CRON
exec node src/index.js
