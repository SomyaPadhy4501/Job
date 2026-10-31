'use strict';

// Daily-run decision, kept pure so it can be tested in Node. Loaded into the
// service worker with importScripts().
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

  const api = { isDue, nextRun, localDay, parseTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
