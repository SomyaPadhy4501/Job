#!/usr/bin/env bash
# One-shot launcher for the Job Aggregator.
# - Picks a free port (default 4000; override with PORT=XXXX ./start.sh)
# - Installs deps on first run
# - Initializes the SQLite DB if missing
# - Opens the UI in your default browser
# - Runs the API + 2-hour scheduler in the foreground (Ctrl+C to stop)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Preflight ───────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node 18+ and retry." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node $NODE_MAJOR found. Need Node 18+." >&2
  exit 1
fi

# ── Find a free port ────────────────────────────────────────────────────────
PREFERRED_PORT="${PORT:-4000}"
PORT="$PREFERRED_PORT"
MAX_PORT=$((PREFERRED_PORT + 20))

while lsof -ti:"$PORT" >/dev/null 2>&1; do
  echo "Port $PORT is busy, trying $((PORT + 1))..."
  PORT=$((PORT + 1))
  if [ "$PORT" -gt "$MAX_PORT" ]; then
    echo "ERROR: no free port between $PREFERRED_PORT and $MAX_PORT." >&2
    exit 1
  fi
done

# ── Install deps on first run ───────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies (first run)..."
  npm install --no-audit --no-fund
fi

# ── Initialize DB if missing ────────────────────────────────────────────────
if [ ! -f data/jobs.db ]; then
  echo "==> Initializing database..."
  npm run init-db
fi

URL="http://localhost:$PORT"

cat <<EOF

============================================================
  Job Aggregator
  URL      : $URL
  DB       : $SCRIPT_DIR/data/jobs.db
  Cron     : every 2 hours (also runs once at startup)
  Stop     : Ctrl+C
============================================================

EOF

# ── Open the browser once the server has a moment to bind ───────────────────
(
  # Wait for the port to start listening, then open the browser.
  for _ in $(seq 1 30); do
    if lsof -ti:"$PORT" >/dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then
        open "$URL" >/dev/null 2>&1 || true
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1 || true
      fi
      exit 0
    fi
    sleep 0.3
  done
) &

# ── Run the server in the foreground so Ctrl+C kills it cleanly ─────────────
export PORT
exec node src/index.js
