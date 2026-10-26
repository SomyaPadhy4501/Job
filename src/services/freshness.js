'use strict';

// Which sources a collect run can vouch for.
//
// Every upsert refreshes a row's last_seen_at, so a row that stops being
// refreshed has been delisted upstream — filled or pulled. That only holds for
// sources that actually got through this run. Without a guard, an outage reads
// as "every job closed", and both kinds happen in production:
//   - getro gets HTTP 429 on 12 of its 16 networks in a typical run
//   - uber reports success with 0 rows (its collector swallows every error)
// So a source counts as refreshed only when it returned at least one row and at
// least half of its fetches succeeded. Dead boards (a few dozen greenhouse,
// ashby and lever slugs 404 every run) are a minority of their source and
// don't block it; their rows stop being refreshed and age out like any other
// delisted job.
function refreshedSources(results) {
  const bySource = new Map();
  for (const r of results) {
    const s = bySource.get(r.company.source) || { ok: 0, fail: 0, rows: 0 };
    if (r.ok) {
      s.ok++;
      s.rows += r.jobs.length;
    } else {
      s.fail++;
    }
    bySource.set(r.company.source, s);
  }
  return [...bySource]
    .filter(([, s]) => s.rows > 0 && s.ok >= s.fail)
    .map(([source]) => source);
}

module.exports = { refreshedSources };
