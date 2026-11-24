'use strict';

// AI tagging inside the collect cron. Runs between normalize and the bulk
// upsert, so the model's role and sponsorship land in the same role_type /
// sponsorship / restriction columns the rule classifiers fill: the board, its
// filters and the API need no change.
//
//   - A posting already stored with the same title and description keeps its
//     stored tags (no model call; this is what stops every 2-hour run from
//     re-asking about thousands of unchanged jobs, and what keeps an earlier
//     AI verdict from being overwritten by the rules).
//   - A new or changed posting with a description is sent to the model,
//     newest first, within a request cap and a time budget.
//   - Anything the model can't answer (budget used up, MINA offline, an
//     answer that fails validation twice) keeps the rule-based tags, exactly
//     as before AI tagging existed.
//
// Enabled by AI_TAGGING=true plus the MINA_* (or AI_MODEL_*) settings read by
// src/services/model-options.js.

const { classify } = require('./ai-tags');
const { approvalsFor, normSlug, USCIS_THRESHOLD } = require('./classifier');
const { deriveRestriction } = require('./clearance');

const enabled = (env = process.env) => env.AI_TAGGING === 'true';

// The JD's own statement decides; when it says nothing (or only "case by
// case" / "transfers"), fall back to the employer's USCIS H-1B record, the
// same signal the rule classifier uses (classifier.js step 4).
function sponsorshipFor(tag, job) {
  if (tag.reason === 'offered') return 'YES';
  if (tag.reason === 'refused') return 'NO';
  if (tag.reason === 'conflicting') return 'UNKNOWN';
  const names = [job.company_name, ...(job.sponsor_company_fallbacks || [])];
  if (job.source === 'getro') {
    // eslint-disable-next-line global-require
    const fromUrl = require('../collectors/getro').employerFromApplyUrl(job.apply_url);
    if (fromUrl) names.push(fromUrl);
  }
  return names.some((n) => n && approvalsFor(normSlug(n)) >= USCIS_THRESHOLD) ? 'YES' : 'UNKNOWN';
}

function applyTag(job, tag) {
  // OTHER means "outside the tracked families". The rules already admitted
  // this posting as software; keep their family rather than hide a real job
  // on one model answer.
  if (tag.role_type !== 'OTHER') job.role_type = tag.role_type;
  job.sponsorship = sponsorshipFor(tag, job);
  // A rule NO_SPONSORSHIP came from the rule verdict, so recompute it from the
  // model's; any other blocking restriction (clearance, ITAR, citizenship,
  // excluded employer) stands.
  job.restriction = deriveRestriction({
    job_title: job.job_title,
    description: job.description,
    company_name: job.company_name,
    sponsorship: job.sponsorship,
    restriction_override: job.restriction === 'NO_SPONSORSHIP' ? undefined : job.restriction,
  });
}

const OUTAGE = /HTTP (?:404|408|429|5\d\d)|fetch failed|timeout|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i;
const MISCONFIGURED = /HTTP (?:400|401|403)/;

// Is this MINA address usable right now? 'up' | 'down' (offline, unreachable,
// erroring) | 'rejected' (answers, but refuses this key or doesn't offer the
// model). A dead Funnel address fails here in seconds instead of costing a
// 90-second model timeout.
async function probeEndpoint(ep, model) {
  try {
    const res = await fetch(ep.models || ep.endpoint.replace(/\/chat\/completions$/, '/models'), {
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: ep.key ? { authorization: 'Bearer ' + ep.key } : {},
    });
    if (res.status === 401 || res.status === 403) return 'rejected';
    if (!res.ok) return 'down';
    const ids = ((await res.json())?.data || []).map((m) => m.id);
    return ids.includes(model) ? 'up' : 'rejected';
  } catch {
    return 'down';
  }
}

/**
 * Tags `jobs` (normalized, deduped rows) in place.
 *
 * Model addresses (options.endpoints, from model-options.js) are tried in
 * order: the first that answers is used for the run; when it goes offline
 * mid-run the same posting is retried on the next one. Only when every
 * address is down does the rest of the run keep rule tags.
 *
 * @param {object[]} jobs
 * @param {object} opts
 * @param {(urls: string[]) => Promise<object[]>} opts.lookup  stored rows by apply_url
 * @param {object} opts.options   model options (model-options.js)
 * @param {number} opts.limit     max model requests this run
 * @param {number} opts.deadline  epoch ms; no new request starts after it
 * @param {Function} [opts.infer] test double for the model call
 * @param {Function} [opts.probe] test double for probeEndpoint (default: none when `infer` is given)
 * @param {Function} [opts.onTag] (job, ruleTags, modelTag) after each accepted verdict
 * @param {Function} [opts.onSwitch] ({ from, to, reason }) when the run changes address
 * @returns {Promise<object>} counts for the collect log
 */
async function tagJobs(jobs, { lookup, options, limit, deadline, infer, probe, onError, onTag, onSwitch }) {
  const endpoints = options.endpoints?.length
    ? options.endpoints
    : [{ endpoint: options.endpoint, key: options.key, label: 'model' }];
  // Only MINA has a /models route to probe; a generic provider (or a test
  // double) is assumed reachable and found out by its first request.
  const check = probe || (infer || !options.mina ? async () => 'up' : (ep) => probeEndpoint(ep, options.model));
  const stats = {
    reused: 0, requested: 0, tagged: 0, failed: 0, deferred: 0, unavailable: false,
    roleChanged: 0, sponsorshipChanged: 0, roles: {}, sponsorship: {},
    used: [], endpoints: Object.fromEntries(endpoints.map((e) => [e.label, { requests: 0, ok: 0, state: 'unchecked' }])),
  };
  let current = -1;
  // Moves to the first usable address at or after `from`; false if none.
  async function pick(from, reason) {
    for (let i = from; i < endpoints.length; i++) {
      const s = stats.endpoints[endpoints[i].label];
      if (s.state === 'down' || s.state === 'rejected') continue;
      s.state = await check(endpoints[i]);
      if (s.state === 'up') {
        if (current >= 0) onSwitch?.({ from: endpoints[current].label, to: endpoints[i].label, reason });
        current = i;
        stats.used.push(endpoints[i].label);
        return true;
      }
    }
    if (endpoints.every((e) => stats.endpoints[e.label].state === 'rejected')) {
      throw new Error('AI model rejected the request (HTTP 401/403 or model not offered); check MINA_BASE_URL / MINA_MODEL / MINA_API_KEY');
    }
    stats.unavailable = true;
    return false;
  }
  const urls = jobs.map((j) => j.apply_url).filter(Boolean);
  const stored = new Map((await lookup(urls)).map((r) => [r.apply_url, r]));

  const todo = [];
  for (const job of jobs) {
    const s = stored.get(job.apply_url);
    if (s && s.job_title === job.job_title && (!job.description || (s.description || '') === job.description)) {
      job.role_type = s.role_type;
      job.sponsorship = s.sponsorship;
      job.restriction = s.restriction;
      stats.reused++;
    } else if (job.description && job.description.trim()) {
      todo.push(job);
    }
  }
  const posted = (j) => j.date_posted || '';
  todo.sort((a, b) => posted(b).localeCompare(posted(a)));

  for (const job of todo) {
    if (stats.unavailable || stats.requested >= limit || Date.now() >= deadline) {
      stats.deferred++;
      continue;
    }
    // Nothing is probed until there is a posting to send: an all-reused run
    // makes no MINA calls at all.
    if (current < 0 && !(await pick(0, 'start'))) {
      stats.deferred++;
      continue;
    }
    stats.requested++;
    for (;;) {
      const ep = endpoints[current];
      const s = stats.endpoints[ep.label];
      s.requests++;
      try {
        const timeout = Math.max(1000, Math.min(options.timeout ?? 25000, deadline - Date.now()));
        const tag = await classify(job, { ...options, endpoint: ep.endpoint, key: ep.key, label: ep.label, timeout }, infer);
        s.ok++;
        const rules = { role_type: job.role_type, sponsorship: job.sponsorship, restriction: job.restriction };
        applyTag(job, tag);
        stats.tagged++;
        if (job.role_type !== rules.role_type) stats.roleChanged++;
        if (job.sponsorship !== rules.sponsorship) stats.sponsorshipChanged++;
        onTag?.(job, rules, tag);
        stats.roles[job.role_type] = (stats.roles[job.role_type] || 0) + 1;
        stats.sponsorship[tag.reason] = (stats.sponsorship[tag.reason] || 0) + 1;
        break;
      } catch (err) {
        onError?.(job, err);
        // A request cut short by the run's own time budget isn't an outage.
        if (Date.now() >= deadline - 1000) {
          stats.deferred++;
          break;
        }
        const rejected = MISCONFIGURED.test(err.message);
        if (rejected || OUTAGE.test(err.message) || err.name === 'TimeoutError') {
          s.state = rejected ? 'rejected' : 'down';
          // Same posting, next PC. pick() throws if every address refused the key.
          if (await pick(current + 1, rejected ? 'rejected' : 'unreachable')) continue;
          stats.deferred++;
          break;
        }
        stats.failed++; // the model answered, but the answer failed validation
        break;
      }
    }
  }
  return stats;
}

module.exports = { enabled, tagJobs, sponsorshipFor, applyTag, probeEndpoint };
