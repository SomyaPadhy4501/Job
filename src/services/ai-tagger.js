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

/**
 * Tags `jobs` (normalized, deduped rows) in place.
 * @param {object[]} jobs
 * @param {object} opts
 * @param {(urls: string[]) => Promise<object[]>} opts.lookup  stored rows by apply_url
 * @param {object} opts.options   model options (model-options.js)
 * @param {number} opts.limit     max model requests this run
 * @param {number} opts.deadline  epoch ms; no new request starts after it
 * @param {Function} [opts.infer] test double for the model call
 * @param {Function} [opts.onTag] (job, ruleTags, modelTag) after each accepted verdict
 * @returns {Promise<object>} counts for the collect log
 */
async function tagJobs(jobs, { lookup, options, limit, deadline, infer, onError, onTag }) {
  const stats = {
    reused: 0, requested: 0, tagged: 0, failed: 0, deferred: 0, unavailable: false,
    roleChanged: 0, sponsorshipChanged: 0, roles: {}, sponsorship: {},
  };
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
    stats.requested++;
    try {
      const timeout = Math.max(1000, Math.min(options.timeout ?? 25000, deadline - Date.now()));
      const tag = await classify(job, { ...options, timeout }, infer);
      const rules = { role_type: job.role_type, sponsorship: job.sponsorship, restriction: job.restriction };
      applyTag(job, tag);
      stats.tagged++;
      if (job.role_type !== rules.role_type) stats.roleChanged++;
      if (job.sponsorship !== rules.sponsorship) stats.sponsorshipChanged++;
      onTag?.(job, rules, tag);
      stats.roles[job.role_type] = (stats.roles[job.role_type] || 0) + 1;
      stats.sponsorship[tag.reason] = (stats.sponsorship[tag.reason] || 0) + 1;
    } catch (err) {
      if (MISCONFIGURED.test(err.message)) throw new Error(`AI model rejected the request (${err.message}); check MINA_BASE_URL / MINA_MODEL / MINA_API_KEY`);
      // A request cut short by the run's own time budget isn't an outage.
      if (Date.now() >= deadline - 1000) stats.deferred++;
      else if (OUTAGE.test(err.message) || err.name === 'TimeoutError') stats.unavailable = true;
      else stats.failed++;
      onError?.(job, err);
    }
  }
  return stats;
}

module.exports = { enabled, tagJobs, sponsorshipFor, applyTag };
