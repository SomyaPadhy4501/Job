'use strict';

// Workday collection from the owner's browser. Workday's Cloudflare answers
// every request from GitHub's runners with a 429 block page (since
// 2026-11-24), while the same requests from a home connection work. So the
// extension reads the Workday boards the server collector used to, and sends
// the rows to /admin/ingest as source "workday", the same rows the collector
// made (src/collectors/workday.js is the reference for the API shape).
//
// Gentle on purpose, because this is the owner's own address and they apply
// through Workday sites: one request at a time, one a second, and the whole run
// stops at the first 429 or block page and waits for the next scheduled run.
// A run is worked through in short ticks (an alarm a minute) with its place
// kept in storage, since Chrome stops an idle service worker after ~30 s.
//
// Loaded into the service worker with importScripts(); also require()-able
// from Node for tests. Chrome APIs come in through `deps`.

(function (root) {
  const PAGE = 20;
  const MAX_LIST = 500; // unfiltered listing cap per employer
  const SEARCH_CAP = 100; // per search, for employers above MAX_LIST
  const SEARCHES = ['software engineer', 'software developer', 'machine learning', 'data engineer', 'data scientist', 'new grad', 'site reliability'];
  const GAP_MS = 1000; // at most one request a second
  const DETAIL_MAX = 40; // descriptions per employer per run
  const RETENTION_DAYS = 14;
  const DESCRIBED_KEEP_DAYS = 30;
  const TICK_BUDGET_MS = 45_000; // start no new employer after this
  const LOCK_MS = 4 * 60_000;

  class Blocked extends Error {}

  const baseUrl = ({ tenant, wd, site }) => `https://${tenant}.wd${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const applyUrl = ({ tenant, wd, site }, path) => `https://${tenant}.wd${wd}.myworkdayjobs.com/en-US/${site}${path}`;

  // Workday writes "2 Locations" for multi-site postings; the path still names
  // the first one ("/job/McLean-VA/...").
  function resolveLocation(j) {
    const text = String(j.locationsText || '').trim();
    if (text && !/^\d+\s+locations?$/i.test(text)) return text;
    const seg = String(j.externalPath || '').split('/')[2];
    if (!seg) return text;
    const m = seg.match(/^(.*)-([A-Z]{2})$/);
    return m ? `${m[1].replace(/-/g, ' ')}, ${m[2]}` : seg.replace(/-/g, ' ');
  }

  function looksUS(loc) {
    if (!loc) return true;
    const l = loc.toLowerCase();
    if (/\b(united states|usa|u\.s\.|u\.s\.a\.)\b/.test(l)) return true;
    if (/\bremote\b/.test(l) && !/\b(emea|apac|europe|asia|uk|canada|india|mexico|brazil)\b/.test(l)) return true;
    return /\b(al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b|california|new york|washington|texas|massachusetts|illinois|georgia|colorado|carolina|virginia|pennsylvania|jersey|maryland|minnesota|michigan|florida|ohio|oregon|arizona|utah|tennessee|indiana|missouri|wisconsin|san francisco|san jose|seattle|boston|austin|chicago|atlanta|denver|portland|san diego|santa clara|sunnyvale|dallas|houston|raleigh/.test(l);
  }

  // Broad on purpose: the server's software filter decides. This only keeps
  // stores, nursing and sales rows out of the upload.
  const TECH = /software|developer|engineer|engineering|scien|data|machine learning|\bml\b|\bai\b|devops|\bsre\b|cloud|security|cyber|\bqa\b|test|mobile|ios|android|web|front[- ]?end|back[- ]?end|full[- ]?stack|platform|infrastructure|firmware|embedded|programmer|analyst|architect/i;
  const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|distinguished|fellow|head|vp|iii|iv|v)\b/i;

  function postedAgeDays(s) {
    const t = String(s || '').toLowerCase();
    if (/today|just posted/.test(t)) return 0;
    if (/yesterday/.test(t)) return 1;
    const m = /(\d+)\+?\s+(hour|day|week|month)/.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'hour' ? 0 : m[2] === 'day' ? n : m[2] === 'week' ? n * 7 : n * 30;
  }

  function parsePostedOn(s, now = new Date()) {
    const age = postedAgeDays(s);
    if (age == null) return null;
    const d = new Date(now);
    const t = String(s).toLowerCase();
    const hours = /(\d+)\+?\s+hour/.exec(t);
    if (hours) d.setHours(d.getHours() - Number(hours[1]));
    else d.setDate(d.getDate() - age);
    return d.toISOString();
  }

  // One request at a time, GAP_MS apart. A 429, a 403 or an HTML page where
  // JSON was asked for is Workday saying stop: the run ends there.
  function requester(fetchFn, sleep, clock) {
    let last = 0;
    return async function request(url, init = {}) {
      for (let attempt = 0; ; attempt++) {
        const wait = last + GAP_MS - clock();
        if (wait > 0) await sleep(wait);
        last = clock();
        let res;
        try {
          res = await fetchFn(url, {
            ...init,
            credentials: 'omit',
            headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
          });
        } catch (err) {
          if (attempt < 1) continue;
          throw err;
        }
        if (res.status === 429 || res.status === 403) throw new Blocked(`Workday answered ${res.status}`);
        if (res.status >= 500 && attempt < 1) continue;
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        if (!/json/i.test(res.headers.get('content-type') || '')) throw new Blocked('Workday sent a web page instead of data');
        return res.json();
      }
    };
  }

  async function pages(t, searchText, cap, request) {
    const items = [];
    let total = Infinity;
    for (let offset = 0; offset < cap; ) {
      let data;
      try {
        data = await request(`${baseUrl(t)}/jobs`, {
          method: 'POST',
          body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText }),
        });
      } catch (err) {
        if (err instanceof Blocked || offset === 0) throw err;
        break; // keep the pages already read
      }
      const batch = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
      if (offset === 0 && Number.isFinite(data?.total)) total = data.total;
      if (!batch.length) break;
      items.push(...batch);
      offset += batch.length;
      if (batch.length < PAGE || offset >= total) break;
    }
    return { items, total };
  }

  async function list(t, request) {
    const first = await pages(t, '', PAGE, request);
    if (first.total > MAX_LIST) {
      const byPath = new Map(first.items.map((j) => [j.externalPath, j]));
      for (const q of t.searches || SEARCHES) {
        const { items } = await pages(t, q, SEARCH_CAP, request);
        for (const j of items) if (!byPath.has(j.externalPath)) byPath.set(j.externalPath, j);
      }
      return [...byPath.values()];
    }
    if (first.total <= first.items.length) return first.items;
    return (await pages(t, '', MAX_LIST, request)).items;
  }

  // Rows worth sending: US, technical, and not past the retention window.
  function keep(j) {
    const age = postedAgeDays(j.postedOn);
    return !!j.title && !!j.externalPath && (age == null || age <= RETENTION_DAYS) && looksUS(resolveLocation(j)) && TECH.test(j.title);
  }

  // Reads one employer. `described` maps apply links to when their description
  // was last sent; those aren't read again (the server keeps a stored one).
  async function collectTenant(t, { request, described = {}, now = new Date() }) {
    const kept = (await list(t, request)).filter(keep);
    const rows = kept.map((j) => ({
      external_id: (Array.isArray(j.bulletFields) && j.bulletFields[0]) || j.externalPath,
      company_name: t.displayName || t.slug,
      job_title: j.title,
      location: resolveLocation(j),
      apply_url: applyUrl(t, j.externalPath),
      description: '',
      date_posted: parsePostedOn(j.postedOn, now),
      _senior: SENIOR.test(j.title),
      _age: postedAgeDays(j.postedOn) ?? 99,
    }));
    const toRead = rows
      .filter((r) => !described[r.apply_url])
      .sort((a, b) => a._senior - b._senior || a._age - b._age)
      .slice(0, DETAIL_MAX);
    for (const r of toRead) {
      const path = r.apply_url.slice(applyUrl(t, '').length);
      try {
        const data = await request(`${baseUrl(t)}${path}`);
        r.description = data?.jobPostingInfo?.jobDescription || '';
      } catch (err) {
        if (err instanceof Blocked) throw err;
      }
    }
    return rows.map(({ _senior, _age, ...r }) => r);
  }

  // Starts a run: fetches the employer list from the job board and records
  // where the run is. Returns the number of employers.
  async function start(deps) {
    const res = await deps.fetch(deps.tenantsUrl, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`Couldn't load the Workday employer list (HTTP ${res.status})`);
    const { tenants } = await res.json();
    if (!Array.isArray(tenants) || !tenants.length) throw new Error('The Workday employer list is empty');
    const at = new Date(deps.clock()).toISOString();
    await deps.storage.set({
      workdayRun: { startedAt: at, tenants, index: 0, ok: 0, failed: 0, found: 0, inserted: 0, updated: 0, rejected: 0 },
      workdayLastRunAt: at,
    });
    return tenants.length;
  }

  // Works through employers for about TICK_BUDGET_MS, sends what it found,
  // and saves its place. Returns { idle } with no run, { busy } while another
  // tick holds the lock, { done, summary } when the run ends, else {}.
  async function tick(deps) {
    const { storage, clock } = deps;
    const { workdayRun: run, workdayTickUntil = 0, workdayDescribed = {} } = await storage.get({
      workdayRun: null,
      workdayTickUntil: 0,
      workdayDescribed: {},
    });
    if (!run) return { idle: true };
    if (workdayTickUntil > clock()) return { busy: true };
    await storage.set({ workdayTickUntil: clock() + LOCK_MS });

    const began = clock();
    const request = requester(deps.fetch, deps.sleep, clock);
    const rows = [];
    let stoppedFor = '';
    try {
      while (run.index < run.tenants.length && clock() - began < TICK_BUDGET_MS) {
        const t = run.tenants[run.index];
        try {
          const found = await collectTenant(t, { request, described: workdayDescribed, now: new Date(clock()) });
          rows.push(...found);
          run.ok++;
          run.found += found.length;
        } catch (err) {
          if (err instanceof Blocked) {
            stoppedFor = err.message;
            break;
          }
          run.failed++;
        }
        run.index++;
      }
      if (rows.length) {
        const r = await deps.post(rows);
        run.inserted += r.inserted || 0;
        run.updated += r.updated || 0;
        run.rejected += r.rejected || 0;
        const stamp = clock();
        for (const row of rows) if (row.description) workdayDescribed[row.apply_url] = stamp;
      }
    } catch (err) {
      stoppedFor = `couldn't send to the job board: ${err.message}`;
    }

    const cutoff = clock() - DESCRIBED_KEEP_DAYS * 86_400_000;
    for (const [url, at] of Object.entries(workdayDescribed)) if (at < cutoff) delete workdayDescribed[url];

    const done = !!stoppedFor || run.index >= run.tenants.length;
    const { tenants, ...counts } = run;
    const summary = { ...counts, total: tenants.length, finishedAt: new Date(clock()).toISOString(), stoppedFor };
    if (done) {
      await storage.set({ workdayLast: summary, workdayDescribed, workdayTickUntil: 0 });
      await storage.remove('workdayRun');
      return { done: true, summary };
    }
    await storage.set({ workdayRun: run, workdayDescribed, workdayTickUntil: 0 });
    return {};
  }

  const api = { start, tick, collectTenant, requester, resolveLocation, looksUS, parsePostedOn, postedAgeDays, keep, Blocked, GAP_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkdayCollect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
