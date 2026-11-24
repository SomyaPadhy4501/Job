'use strict';

// Phenom People career sites, plus one tenant that only looks like one.
//
// Two ways in, chosen per tenant:
//
// `widgets` (Cisco). A Phenom search page shows 10 jobs and pages with
// `?from=10`, `?from=20`, … — it never infinite-scrolls, so the old
// scroll-and-collect-anchors loop only ever saw the first 10 cards (10 Cisco
// rows per run, against 486 US openings on 2026-11-24). The page's own data
// source is a same-origin JSON endpoint:
//
//   POST /widgets  { ddoKey: 'refineSearch', from, size (≤100), pageId,
//                    selected_fields: { country: ['United States of America'] }, … }
//   header x-csrf-token: phApp.sessionParams.csrfToken
//     → { refineSearch: { status, hits, totalHits, data: { jobs: [{ jobId,
//         title, location, country, postedDate, descriptionTeaser, applyUrl,
//         multi_location, … }] } } }
//
// The target loads the search page once (for cookies and the CSRF token) and
// calls that endpoint from inside the page, one page of 100 at a time, a
// second apart, until totalHits. Cisco's `applyUrl` is its Workday posting —
// the same requisitions the `workday` collector reads from cisco.wd5
// Cisco_Careers — so rows carry that link in the Workday collector's format and
// the Workday entry's company name, letting the two copies meet in dedupe.
//
// `dom` (Cognizant). careers.cognizant.com is not a Phenom site (its own
// front end; requisition ids like 00069154012) and has no JSON endpoint we can
// reach: since at least 2026-11-24 every listing and job page answers plain
// HTTP with a Cloudflare challenge ("Just a moment..."), which is why the
// 03:00Z run got 0 rows. The DOM path stays for it, but a challenge page or a
// page with no job links is now a failure, not an empty success.
//
// A tenant that fails is logged as target.phenom.fail and the others' rows are
// kept; if every tenant fails, run() throws so the scraper reports the target
// as failed.
//
// This target intentionally shares `source: 'phenom'` across tenants so rows
// merge cleanly in the DB.

const { CONFIG } = require('../config');
const log = require('../logger');

const WIDGET_PAGE_SIZE = 100; // the largest `size` the endpoint honours
const WIDGET_MAX_PAGES = 30; // 3,000 rows: several times Cisco's US openings
const WIDGET_DELAY_MS = 1000;

const TENANTS = [
  {
    slug: 'cisco',
    // Same name as the workday entry (src/config.js, cisco-cisco_careers), so
    // a posting both sources see dedupes as one company's.
    displayName: 'Cisco Systems',
    mode: 'widgets',
    url: 'https://careers.cisco.com/global/en/search-results',
    origin: 'https://careers.cisco.com',
    jobPath: '/global/en/job/',
    countryField: 'country',
    countryValue: 'United States of America',
    // Rewrite Phenom's Workday apply link to the workday collector's form.
    workday: { host: 'cisco.wd5.myworkdayjobs.com', site: 'Cisco_Careers' },
  },
  {
    slug: 'cognizant',
    displayName: 'Cognizant',
    mode: 'dom',
    url: 'https://careers.cognizant.com/global-en/jobs/',
    jobUrlPattern: /\/global-en\/jobs\/(\d+)/,
    applyUrlPrefix: 'https://careers.cognizant.com',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksUSCandidate(locationText) {
  if (!locationText) return true; // no location visible = don't pre-drop
  const l = locationText.toLowerCase();
  if (/\b(united states|usa|\bu\.s\.a?\b)\b/.test(l)) return true;
  if (/\b(remote|anywhere|multiple\s+locations)\b/.test(l) && !/\bemea|apac|europe|asia|india|uk|canada|\bindia\b/.test(l)) return true;
  return /\b(california|new york|washington|texas|massachusetts|illinois|georgia|colorado|virginia|pennsylvania|north carolina|new jersey|maryland|michigan|minnesota|florida|ohio|oregon|arizona|utah|tennessee|missouri|san francisco|san jose|seattle|boston|austin|chicago|atlanta|denver|portland|san diego|palo alto|mountain view|sunnyvale|bellevue|cambridge|brooklyn|houston|dallas|minneapolis|redmond)\b/.test(l);
}

// A Cloudflare interstitial instead of the site. Checked on title and markup
// so a tenant that is being refused fails loudly instead of yielding 0 rows.
// Only `_cf_chl_opt` marks the interstitial itself: ordinary pages behind
// Cloudflare can load challenges.cloudflare.com (Turnstile) or the
// /cdn-cgi/challenge-platform beacon without being a challenge.
function isBotChallenge({ title = '', html = '' } = {}) {
  return /^\s*just a moment/i.test(title) || /attention required/i.test(title) || /_cf_chl_opt/.test(html);
}

// ─── widgets mode ────────────────────────────────────────────────────────────

function refineSearchBody({ from, size, pageId, tenant }) {
  return {
    lang: 'en_global',
    deviceType: 'desktop',
    country: 'global',
    pageName: 'search-results',
    ddoKey: 'refineSearch',
    sortBy: '',
    subsearch: '',
    from,
    jobs: true,
    counts: true,
    all_fields: [tenant.countryField],
    size,
    clearAll: false,
    jdsource: 'facets',
    isSliderEnable: false,
    pageId,
    siteType: 'external',
    keywords: '',
    global: true,
    selected_fields: { [tenant.countryField]: [tenant.countryValue] },
    locationData: {},
  };
}

// { total, jobs } from a /widgets response, or null when it isn't one.
function parseRefineSearch(json) {
  const rs = json?.refineSearch;
  if (!rs || !Array.isArray(rs.data?.jobs)) return null;
  return { total: Number(rs.totalHits) || 0, jobs: rs.data.jobs };
}

// Phenom's applyUrl for a Workday-backed tenant ends in /apply and has no
// locale; the workday collector stores /en-US/{site}/job/… . Same posting, so
// emit the collector's form. Any other link is left alone.
function workdayApplyUrl(applyUrl, workday) {
  if (!applyUrl || !workday) return null;
  let u;
  try {
    u = new URL(applyUrl);
  } catch {
    return null;
  }
  if (u.host !== workday.host) return null;
  const path = u.pathname.replace(/\/apply\/?$/, '');
  const m = path.match(new RegExp(`^/(?:[a-z]{2}-[A-Z]{2}/)?${workday.site}(/job/.+)$`));
  return m ? `https://${workday.host}/en-US/${workday.site}${m[1]}` : null;
}

function mapWidgetJob(job, tenant) {
  const id = String(job.jobId || job.reqId || '');
  const isUS = /^united states/i.test(String(job.country || ''));
  return {
    source: 'phenom',
    external_id: id || null,
    company_name: tenant.displayName,
    job_title: String(job.title || '').trim(),
    location: job.location || job.cityStateCountry || '',
    countries: job.country ? [isUS ? 'US' : String(job.country)] : undefined,
    apply_url:
      workdayApplyUrl(job.applyUrl, tenant.workday) ||
      (id ? `${tenant.origin}${tenant.jobPath}${id}` : job.applyUrl || ''),
    description: job.descriptionTeaser || '',
    date_posted: job.postedDate || job.dateCreated || null,
  };
}

async function scrapeWidgets(page, tenant) {
  await page.goto(tenant.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  if (isBotChallenge({ title, html })) throw new Error(`bot challenge at ${tenant.url}`);

  const session = await page.evaluate(() => ({
    csrf: window.phApp?.sessionParams?.csrfToken || '',
    pageId: window.phApp?.pageId || '',
  }));
  if (!session.csrf || !session.pageId) {
    throw new Error('no phApp session (csrfToken/pageId) on the search page: not a Phenom page any more?');
  }

  const byId = new Map();
  let total = Infinity;
  for (let i = 0; i < WIDGET_MAX_PAGES && byId.size < total; i++) {
    if (i > 0) await sleep(tenant.delayMs ?? WIDGET_DELAY_MS);
    const body = refineSearchBody({ from: i * WIDGET_PAGE_SIZE, size: WIDGET_PAGE_SIZE, pageId: session.pageId, tenant });
    const res = await page.evaluate(
      async ({ body, csrf }) => {
        const r = await fetch('/widgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        });
        const text = await r.text();
        return { status: r.status, text };
      },
      { body, csrf: session.csrf }
    );
    let parsed = null;
    try {
      parsed = parseRefineSearch(JSON.parse(res.text));
    } catch {
      /* not JSON: handled below */
    }
    if (!parsed) {
      const msg = `widgets page ${i + 1} returned HTTP ${res.status} without refineSearch data`;
      if (i === 0) throw new Error(msg);
      log.warn('target.phenom.partial', { tenant: tenant.slug, kept: byId.size, error: msg });
      break;
    }
    if (i === 0 && !parsed.jobs.length) {
      throw new Error(`widgets search for ${tenant.countryValue} returned 0 jobs (filter or API changed)`);
    }
    if (parsed.total) total = parsed.total;
    for (const j of parsed.jobs) {
      const id = String(j.jobId || j.reqId || '');
      if (id && !byId.has(id)) byId.set(id, j);
    }
    if (parsed.jobs.length < WIDGET_PAGE_SIZE) break;
  }

  log.info('target.phenom.rows', { tenant: tenant.slug, rows: byId.size, total });
  return [...byId.values()].map((j) => mapWidgetJob(j, tenant)).filter((r) => r.job_title && r.apply_url);
}

// ─── dom mode ────────────────────────────────────────────────────────────────

async function scrapeDom(page, tenant) {
  await page.goto(tenant.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  await page.waitForTimeout(3500);

  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  if (isBotChallenge({ title, html })) throw new Error(`bot challenge at ${tenant.url}`);

  // Infinite-scroll attempt: scroll N times, click any "show more" that appears.
  let previousCount = 0;
  let stable = 0;
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, 2500)).catch(() => {});
    await page.waitForTimeout(1200);
    await page
      .evaluate(() => {
        const btn = [...document.querySelectorAll('button,a')].find((b) =>
          /show\s+more|load\s+more|view\s+more|more\s+jobs/i.test(b.innerText || '')
        );
        btn?.click();
      })
      .catch(() => {});
    await page.waitForTimeout(1200);
    const count = await page
      .evaluate(() => document.querySelectorAll('a[href]').length)
      .catch(() => 0);
    if (count === previousCount) stable++;
    else stable = 0;
    previousCount = count;
    if (stable >= 3) break;
  }

  const rows = await page.evaluate((patternSrc) => {
    const patt = new RegExp(patternSrc);
    const anchors = [...document.querySelectorAll('a[href]')].filter((a) => patt.test(a.href));
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const card = a.closest(
        '[class*="card"], [class*="result"], [class*="job"], li, article, div.ph-search-results-v2__item'
      ) || a.parentElement;
      // Pull the first text line that looks like a location.
      let location = '';
      const txt = (card?.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      for (const line of txt) {
        if (/\b(united states|usa|remote|anywhere|[A-Z][a-z]+,\s*[A-Z]{2}\b)/i.test(line) && line.length < 80) {
          location = line;
          break;
        }
      }
      out.push({
        href: a.href,
        title: (a.innerText || '').trim().split('\n')[0].slice(0, 200),
        location,
      });
    }
    return out;
  }, tenant.jobUrlPattern.source);

  log.info('target.phenom.rows', { tenant: tenant.slug, rows: rows.length });
  // A careers listing with no job links at all is a layout change or a block
  // the challenge check didn't recognise, not an employer with no openings.
  if (!rows.length) throw new Error(`no job links matching ${tenant.jobUrlPattern} on ${tenant.url}`);

  return rows
    .filter((r) => r.title && r.href && looksUSCandidate(r.location))
    .map((r) => {
      const idMatch = r.href.match(tenant.jobUrlPattern);
      return {
        source: 'phenom',
        external_id: idMatch ? idMatch[1] : r.href,
        company_name: tenant.displayName,
        job_title: r.title,
        location: r.location,
        apply_url: r.href.startsWith('http') ? r.href : tenant.applyUrlPrefix + r.href,
        description: '',
        date_posted: null,
      };
    });
}

async function scrapeTenant(context, tenant) {
  const page = await context.newPage();
  try {
    return tenant.mode === 'widgets' ? await scrapeWidgets(page, tenant) : await scrapeDom(page, tenant);
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function run(context, { tenants = TENANTS } = {}) {
  const all = [];
  const failures = [];
  for (const tenant of tenants) {
    try {
      all.push(...(await scrapeTenant(context, tenant)));
    } catch (err) {
      failures.push(`${tenant.slug}: ${err.message}`);
      log.warn('target.phenom.fail', { tenant: tenant.slug, error: err.message });
    }
  }
  if (failures.length && failures.length === tenants.length) {
    throw new Error(`every phenom tenant failed — ${failures.join('; ')}`);
  }
  return all;
}

module.exports = {
  run,
  source: 'phenom',
  TENANTS,
  isBotChallenge,
  parseRefineSearch,
  refineSearchBody,
  mapWidgetJob,
  workdayApplyUrl,
};
