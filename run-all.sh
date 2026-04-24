#!/usr/bin/env bash
# Unified launcher for the whole stack: main API + scraper microservice.
#
# Run ./run-all.sh and you get:
#   - Main service on http://localhost:$PORT (default 4000, auto-picks free)
#   - Scraper service scraping every 6h, POSTing to /admin/ingest
#   - Browser auto-opens once the main service is listening
#   - Interleaved logs with [main] and [scr ] prefixes
#   - Ctrl+C cleanly stops both

set -euo pipefail
# Enable job control so each backgrounded pipeline gets its own process group,
# letting `kill -TERM -$pid` take down the whole group cleanly.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

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

# ── Pick a free port for the main service ──────────────────────────────────
PREFERRED_PORT="${PORT:-4000}"
PORT="$PREFERRED_PORT"
while lsof -ti:"$PORT" >/dev/null 2>&1; do
  echo "Port $PORT is busy, trying $((PORT + 1))..."
  PORT=$((PORT + 1))
  if [ "$PORT" -gt $((PREFERRED_PORT + 20)) ]; then
    echo "ERROR: no free port near $PREFERRED_PORT" >&2
    exit 1
  fi
done

# ── Install main deps + init DB on first run ────────────────────────────────
if [ ! -d node_modules ]; then
  echo "==> Installing main dependencies..."
  npm install --no-audit --no-fund
fi
if [ ! -f data/jobs.db ]; then
  echo "==> Initializing database..."
  npm run init-db >/dev/null
fi

# ── Install scraper deps + Chromium on first run (skippable) ────────────────
RUN_SCRAPER="${RUN_SCRAPER:-true}"
if [ "$RUN_SCRAPER" = "true" ]; then
  if [ ! -d scraper/node_modules ]; then
    echo "==> Installing scraper dependencies..."
    (cd scraper && npm install --no-audit --no-fund)
  fi
  # Detect a missing Chromium install (macOS default cache path).
  if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && \
     [ ! -d scraper/node_modules/playwright/.local-browsers ]; then
    echo "==> Downloading Chromium for Playwright (first run, ~250 MB)..."
    (cd scraper && npx playwright install chromium)
  fi
fi

URL="http://localhost:$PORT"
MAIN_LOG="/tmp/job-main.log"
SCR_LOG="/tmp/job-scraper.log"
# Keep a short rolling log rather than appending forever.
: > "$MAIN_LOG"
: > "$SCR_LOG"

cat <<EOF

================================================================
  Job Aggregator — unified run
  Main URL   : $URL
  Scraper    : ${RUN_SCRAPER} (POST to $URL/admin/ingest every 6h)
  Main log   : $MAIN_LOG
  Scraper log: $SCR_LOG
  Stop       : Ctrl+C  (kills both services cleanly)
================================================================

EOF

# ── Spawn main service ──────────────────────────────────────────────────────
PORT="$PORT" node src/index.js >> "$MAIN_LOG" 2>&1 &
MAIN_PID=$!

# ── Wait for main to be listening (max 30 s) ────────────────────────────────
for i in $(seq 1 60); do
  if curl -sf "$URL/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$MAIN_PID" 2>/dev/null; then
    echo "ERROR: main service exited during startup. Last lines of $MAIN_LOG:" >&2
    tail -10 "$MAIN_LOG" >&2
    exit 1
  fi
  sleep 0.5
done

# ── Open browser once ───────────────────────────────────────────────────────
(
  if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  fi
) &

# ── Spawn scraper (if enabled) ──────────────────────────────────────────────
# `exec` inside the subshell replaces it with the node process, so $! becomes
# the real node PID and kill signals reach it directly.
SCRAPER_PID=
if [ "$RUN_SCRAPER" = "true" ]; then
  (
    cd "$ROOT/scraper"
    exec env INGEST_URL="$URL/admin/ingest" node src/index.js
  ) >> "$SCR_LOG" 2>&1 &
  SCRAPER_PID=$!
fi

# ── Tail both logs with prefixes ────────────────────────────────────────────
tail -f "$MAIN_LOG" | sed -u 's/^/[main] /' &
TAIL_MAIN=$!

TAIL_SCR=
if [ -n "$SCRAPER_PID" ]; then
  tail -f "$SCR_LOG" | sed -u 's/^/[scr ] /' &
  TAIL_SCR=$!
fi

# ── Clean shutdown on any signal ────────────────────────────────────────────
cleanup() {
  trap - EXIT INT TERM            # avoid re-entry
  echo
  echo "→ Stopping services (main=$MAIN_PID scraper=${SCRAPER_PID:-none})..."
  # Send TERM to the node processes and their children (negative PID = pgroup).
  for pid in "$SCRAPER_PID" "$MAIN_PID"; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
    kill -TERM "-$pid" 2>/dev/null || true
  done
  # Also stop the log-tailers so we don't trail zombie processes.
  [ -n "$TAIL_MAIN" ] && kill "$TAIL_MAIN" 2>/dev/null || true
  [ -n "$TAIL_SCR" ]  && kill "$TAIL_SCR"  2>/dev/null || true
  # Grace window, then force-kill anything stubborn.
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    local alive=""
    for pid in "$MAIN_PID" "$SCRAPER_PID"; do
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive="y"
    done
    [ -z "$alive" ] && break
  done
  for pid in "$SCRAPER_PID" "$MAIN_PID"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
    [ -n "$pid" ] && kill -KILL "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "→ Stopped."
  exit 0
}
trap cleanup EXIT INT TERM

# ── Wait for main to exit, noting scraper death along the way ───────────────
# We use a polling loop instead of `wait -n` because macOS ships bash 3.2.57
# (frozen since 2007), and `wait -n` is a bash 4.3+ feature. Main is the
# service that matters; if the scraper dies we log it and keep main running.
SCRAPER_DIED_REPORTED=false
while kill -0 "$MAIN_PID" 2>/dev/null; do
  if [ -n "$SCRAPER_PID" ] && ! kill -0 "$SCRAPER_PID" 2>/dev/null; then
    if [ "$SCRAPER_DIED_REPORTED" = "false" ]; then
      echo "[run-all] scraper exited — main still serving. Restart ./run-all.sh to bring scraper back."
      SCRAPER_DIED_REPORTED=true
      SCRAPER_PID=
    fi
  fi
  sleep 2
done
