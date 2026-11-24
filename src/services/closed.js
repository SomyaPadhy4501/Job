'use strict';

// Closed-job detection. A posting the employer closes should leave the board
// within hours, not linger until its date ages past retention.
//
// After a collect run, for each company whose collector returned its whole
// listing, a stored row of that source and company that nothing listed this
// run counts one miss. Two misses in a row and the row is deleted; any
// sighting resets the count. Only collectors with `fullListing: true` take
// part (see src/collectors/index.js); a failed fetch, an empty answer or a
// listing the collector marks `partial` never counts against anyone.
//
// "Listed this run" is deliberately wide: the row's link appears in ANY
// collector's answer, or anything (another source, a scraper or extension
// ingest) updated the row since the run started. So a job another source
// still lists is never counted missing, whichever source inserted the row.

const { cleanCompanyName, canonicalUrl } = require('./normalize');

const CLOSE_AFTER_MISSES = 2;

function scopeKey(source, companyName) {
  return `${source}\u0000${companyName}`;
}

// Companies (source + stored company name) whose rows may be judged this run.
// A company whose fetch failed, came back empty or partial blocks its name for
// that source, so a second board of the same name (two Workday sites of one
// employer, say) can't make the first board's rows look closed.
function closableScopes(results, getCollector) {
  const scopes = new Map();
  const blocked = new Set();
  for (const r of results) {
    const source = r.company.source;
    const names = new Set(r.jobs.map((j) => cleanCompanyName(j.company_name)).filter(Boolean));
    const complete = r.ok && !!getCollector(source)?.fullListing && r.jobs.length > 0 && !r.jobs.partial;
    if (!complete) {
      names.add(cleanCompanyName(r.company.displayName || r.company.slug));
      for (const n of names) blocked.add(scopeKey(source, n));
      continue;
    }
    for (const n of names) scopes.set(scopeKey(source, n), { source, company_name: n });
  }
  for (const k of blocked) scopes.delete(k);
  return [...scopes.values()];
}

// Every link any collector answered with this run, as comparison keys.
function seenUrlsOf(results) {
  const seen = new Set();
  for (const r of results) {
    if (!r.ok) continue;
    for (const j of r.jobs) if (j.apply_url) seen.add(canonicalUrl(j.apply_url));
  }
  return seen;
}

// SQLite stores datetime('now') as "YYYY-MM-DD HH:MM:SS" (UTC, no zone);
// Postgres rows hold ISO strings. Read both as UTC.
function timeOf(ts) {
  const s = String(ts || '');
  return Date.parse(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

// One company's stored rows → what to do with each. A company where most rows
// would go missing at once is left alone and reported: that looks more like a
// changed or truncated API than an employer closing most of its roles.
function planClosures(rows, { seenUrls, since }) {
  const sinceMs = timeOf(since);
  const plan = { reset: [], missed: [], closed: [], suspicious: false };
  const unseen = [];
  for (const row of rows) {
    const seen = seenUrls.has(canonicalUrl(row.apply_url)) || timeOf(row.last_seen_at) >= sinceMs;
    if (seen) {
      if (row.missed_runs > 0) plan.reset.push(row.id);
    } else {
      unseen.push(row);
    }
  }
  if (unseen.length > 2 && unseen.length * 2 > rows.length) {
    plan.suspicious = true;
    return plan;
  }
  for (const row of unseen) {
    if ((row.missed_runs || 0) + 1 >= CLOSE_AFTER_MISSES) plan.closed.push(row.id);
    else plan.missed.push(row.id);
  }
  return plan;
}

module.exports = { CLOSE_AFTER_MISSES, closableScopes, seenUrlsOf, planClosures, timeOf };
