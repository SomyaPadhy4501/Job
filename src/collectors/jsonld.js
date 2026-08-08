'use strict';

const { runWithConcurrency } = require('./http');

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
//   { source: 'jsonld', slug, displayName, sitemapUrl, jobPath, maxDetail }

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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractSitemapUrls(xml, jobPath) {
  const locs = xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/g) || [];
  return locs
    .map((l) => l.replace(/<\/?loc>/g, '').trim())
    .filter((u) => u.includes(jobPath));
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
  } = company;

  if (!sitemapUrl) throw new Error(`jsonld company "${slug}" missing sitemapUrl`);

  const xml = await fetchText(sitemapUrl);
  const all = extractSitemapUrls(xml, jobPath);
  const candidates = all.filter((u) => SOFTWARE_URL_HINT.test(u)).slice(0, maxDetail);

  const results = await runWithConcurrency(candidates, CONCURRENCY, async (url) => {
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
      return null; // one dead posting shouldn't fail the company
    }
  });

  // runWithConcurrency substitutes { __error } for a throwing worker rather than
  // rejecting, so a plain Boolean filter would let those through as fake jobs.
  return results.filter((r) => r && !r.__error);
}

module.exports = { fetchCompany, source: 'jsonld' };
