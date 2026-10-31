'use strict';

// Run-schedule decisions, kept pure so they can be tested in Node. Loaded into
// the service worker with importScripts(). The extension uses isDueEvery (every
// N hours, owner's call 2026-10-31); isDue is the earlier once-a-day rule.
//
// Rule: run once per local calendar day, at or after the scheduled time. If
// the computer or Chrome was off at that time, the first check after it comes
// back on (browser startup, or the next periodic alarm) runs it.

(function (root) {
  function localDay(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function parseTime(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return { h: 10, m: 0 };
    return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
  }

  // now: Date. lastRunDay: 'YYYY-MM-DD' or ''. time: 'HH:MM'.
  function isDue(now, lastRunDay, time) {
    if (lastRunDay === localDay(now)) return false;
    const { h, m } = parseTime(time);
    return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  }

  // Next scheduled time strictly after `now`, for chrome.alarms.
  function nextRun(now, time) {
    const { h, m } = parseTime(time);
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  }

  // Interval mode: due when `hours` have passed since the last run (ISO
  // string, or '' for never). A machine that was off or asleep past the
  // interval runs on the first check after it wakes.
  function isDueEvery(now, lastRunAt, hours) {
    const h = Number(hours) > 0 ? Number(hours) : 3;
    if (!lastRunAt) return true;
    const last = new Date(lastRunAt).getTime();
    if (!Number.isFinite(last)) return true;
    return now.getTime() - last >= h * 3_600_000;
  }

  const api = { isDue, isDueEvery, nextRun, localDay, parseTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
