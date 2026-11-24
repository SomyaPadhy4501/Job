'use strict';

const { runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');

// Generic collector for career sites that publish schema.org JobPosting data.
//
// Two deliberately conservative choices, because this collector reads ordinary
// web pages rather than a documented API:
//
//   1. Job URLs come from the site's own sitemap.xml — a file published
//      specifically for automated consumers.
//   2. Job data comes from the <script type="application/ld+json"> JobPosting
//      block, which sites embed precisely so machines can read the posting.
//
// Nothing here touches a path a site disallows in robots.txt. Intuit, the first
// consumer, disallows /search-jobs/ (its internal search API) but not the
// sitemap or the /job/ detail pages this uses. **Check robots.txt before adding
// a company here**, and skip any site that gates content behind bot detection.
//
// Config shape:
//   { source: 'jsonld', slug, displayName, sitemapUrl, jobPath, maxDetail, concurrency }

const DEFAULT_JOB_PATH = '/job/';
// Cap on detail fetches per company per run. Sized to cover the whole
// software-filtered candidate set rather than truncate it — Intuit's sitemap
// yields 137 candidates from 388 job URLs, so 120 was silently dropping 17.
// Raise if a new company exceeds it; the pre-filter keeps this well under the
// full sitemap size.
const DEFAULT_MAX_DETAIL = 250;
const CONCURRENCY = 4;          // deliberately gentle
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

// Job URLs embed the title as a slug ("/job/mountain-view/staff-software-engineer/..."),
// so most non-software postings can be discarded before fetching anything. Same
// idea as the title pre-filter in workday.js — it keeps a 388-URL sitemap down
// to a few dozen detail fetches.
const SOFTWARE_URL_HINT =
  /software|developer|\bswe\b|\bsde\b|engineer|full[-_]?stack|frontend|front[-_]end|backend|back[-_]end|platform|infrastructure|site[-_]reliability|\bsre\b|machine[-_]learning|\bml\b|data[-_](?:scientist|engineer)|ai[-_]|android|ios|mobile|security|devops|cloud|architect/i;

// With a timeout (a hung career site used to stall the whole run), and one
// patient retry on 429: these are ordinary web servers, not APIs, and a short
// pause is what they ask for.
async function fetchText(url, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });
    if (res.ok) return res.text();
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 10) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

// Job URLs from a sitemap, each with its <lastmod> when the site gives one.
function extractSitemapEntries(xml, jobPath) {
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g);
  const entries = blocks
    ? blocks.map((b) => ({
        url: (b.match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1] || '',
        lastmod: (b.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1] || null,
      }))
    : (xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/g) || []).map((l) => ({
        url: l.replace(/<\/?loc>/g, '').trim(),
        lastmod: null,
      }));
  return entries
    .map((e) => ({ ...e, url: e.url.replace(/&amp;/g, '&') }))
    .filter((e) => e.url.includes(jobPath));
}

function extractSitemapUrls(xml, jobPath) {
  return extractSitemapEntries(xml, jobPath).map((e) => e.url);
}

// A posting not modified within the retention window can't be newer than it:
// skip its page instead of fetching it only for normalize to drop it.
function isFresh(lastmod, retentionDays) {
  if (!lastmod || !retentionDays) return true;
  const t = Date.parse(lastmod);
  return !Number.isFinite(t) || t >= Date.now() - retentionDays * 86_400_000;
}

// Pull the first JobPosting object out of the page's JSON-LD blocks. Handles
// both a bare object and an @graph array, which sites use interchangeably.
function extractJobPosting(html) {
  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return null;
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue; // a malformed block on one page shouldn't kill the run
    }
    const candidates = Array.isArray(data)
      ? data
      : Array.isArray(data['@graph'])
        ? data['@graph']
        : [data];
    for (const c of candidates) {
      if (c && c['@type'] === 'JobPosting') return c;
    }
  }
  return null;
}

// schema.org allows jobLocation to be an object or an array of them, and the
// address fields are optional. Produce the "City, ST" shape looksUS expects.
function locationFrom(posting) {
  const raw = posting.jobLocation;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const addr = (first && first.address) || {};
  const city = addr.addressLocality || '';
  const region = addr.addressRegion || '';
  const country = addr.addressCountry || '';
  const parts = [city, region].filter(Boolean);
  if (parts.length) {
    // Keep the country only when it isn't the US — "Bangalore, Karnataka, India"
    // must stay identifiably foreign, while US rows read "San Francisco, California".
    const c = String(typeof country === 'object' ? country.name || '' : country);
    if (c && !/^(us|usa|united states)$/i.test(c.trim())) parts.push(c);
    return parts.join(', ');
  }
  return typeof country === 'string' ? country : '';
}

async function fetchCompany(company) {
  const {
    slug,
    displayName,
    sitemapUrl,
    jobPath = DEFAULT_JOB_PATH,
    maxDetail = DEFAULT_MAX_DETAIL,
    concurrency = CONCURRENCY,
  } = company;

  if (!sitemapUrl) throw new Error(`jsonld company "${slug}" missing sitemapUrl`);

  const xml = await fetchText(sitemapUrl);
  const all = extractSitemapEntries(xml, jobPath);
  const candidates = all
    .filter((e) => SOFTWARE_URL_HINT.test(e.url) && isFresh(e.lastmod, CONFIG.retentionDays))
    .map((e) => e.url)
    .slice(0, maxDetail);

  let failed = 0;
  const results = await runWithConcurrency(candidates, concurrency, async (url) => {
    try {
      const html = await fetchText(url);
      const p = extractJobPosting(html);
      if (!p || !p.title) return null;
      return {
        source: 'jsonld',
        external_id: String(p.identifier?.value || p.identifier || url),
        company_name: displayName || p.hiringOrganization?.name || slug,
        job_title: p.title,
        location: locationFrom(p),
        apply_url: p.url || url,
        description: p.description || '',
        date_posted: p.datePosted || null,
      };
    } catch {
      failed++;
      return null; // one dead posting shouldn't fail the company
    }
  });
  // Every page refused (blocked, rate-limited): a failed company, not an empty one.
  if (candidates.length && failed === candidates.length) {
    throw new Error(`all ${failed} job pages failed for ${slug}`);
  }

  // runWithConcurrency substitutes { __error } for a throwing worker rather than
  // rejecting, so a plain Boolean filter would let those through as fake jobs.
  return results.filter((r) => r && !r.__error);
}

module.exports = { fetchCompany, source: 'jsonld', extractSitemapEntries, extractSitemapUrls, isFresh };
