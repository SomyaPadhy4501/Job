#!/usr/bin/env bash
# Sends job alerts after a collect: asks the Rust API to run the due alerts
# (POST /api/cron/alerts, crates/api/src/alerts.rs) until none remain.
#
#   CRON_SECRET=… SITE_URL=https://job-two-xi.vercel.app send-alerts.sh
#
# Each call handles one small batch (a Vercel function has seconds, not
# minutes) and answers {"remaining": n}. Calls are 30 seconds apart: faster
# loops trip Vercel's firewall, which then blocks every extension call too.
# Without CRON_SECRET this does nothing, so the collect workflow runs the same
# before the owner sets alerts up. Once it's set, a failed call fails the step.
set -euo pipefail

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET is unset; no alerts sent"
  exit 0
fi
url="${SITE_URL:-https://job-two-xi.vercel.app}"
url="${url%/}/api/cron/alerts"

for call in $(seq 1 20); do
  if ! body=$(curl -sS --fail-with-body --max-time 120 -X POST \
    -H "Authorization: Bearer $CRON_SECRET" "$url"); then
    echo "alert run failed (call $call): $body"
    exit 1
  fi
  echo "call $call: $body"
  remaining=$(jq -r '.remaining // 0' <<<"$body")
  [ "$remaining" -gt 0 ] || exit 0
  sleep 30
done
echo "still $remaining alerts due after $call calls; the next collect sends them"
