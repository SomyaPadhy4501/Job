#!/usr/bin/env bash
# Decides whether a scheduled run should do its work, for a steady cadence on
# top of GitHub's unreliable cron. GitHub delays and drops scheduled runs (a
# 2-hourly collect really ran every 3.5-9 hours), so the workflows are
# triggered every 30 minutes and each trigger asks: when did the work last
# really run (not just a trigger that skipped itself)?
#
#   due.sh <workflow file> <step name> <every minutes> <retry minutes>
#
# Due when the last real run started at least <every> minutes ago, or failed
# at least <retry> minutes ago. Writes due=true|false to $GITHUB_OUTPUT.
set -euo pipefail
workflow=$1
step=$2
every=$3
retry=$4

now=$(date +%s)
due=true
reason="no run of \"$step\" in the last $every minutes"
# Newest first. Stops at the first run old enough, so this costs a few API calls.
runs=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$workflow" --status completed --limit 40 \
  --json databaseId,createdAt --jq '.[] | "\(.databaseId) \(.createdAt)"')
while read -r id created; do
  [ -n "$id" ] || continue
  age=$(((now - $(date -d "$created" +%s)) / 60))
  [ "$age" -lt "$every" ] || break
  result=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs" \
    --jq "[.jobs[].steps[] | select(.name == \"$step\") | .conclusion | select(. == \"success\" or . == \"failure\")] | first // empty")
  [ -n "$result" ] || continue # a trigger that skipped itself
  if [ "$result" = success ]; then
    due=false
    reason="last ran $age minutes ago"
  elif [ "$age" -lt "$retry" ]; then
    due=false
    reason="last run failed $age minutes ago; trying again after $retry minutes"
  else
    reason="last run failed $age minutes ago; trying again"
  fi
  break
done <<<"$runs"

echo "due=$due ($reason)"
echo "due=$due" >>"$GITHUB_OUTPUT"
