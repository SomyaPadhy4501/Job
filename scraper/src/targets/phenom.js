'use strict';

// Generic Phenom People careers-page scraper. Each Phenom tenant renders a
// client-side SPA on top of the `/widgets` API, but the job cards on the
// results page are reliably addressable via DOM selectors regardless of
// which widget-ID graph the backend is using.
//
// We drive each tenant through its search-results URL, scroll a few times
// (Phenom uses infinite scroll for pagination), and extract visible job
// cards. Coverage is limited — most Phenom tenants gate beyond the first
// N visible results behind user interaction that Playwright can't reliably
// reproduce. We accept that: the alternative is decoding the widget graph
// per tenant, which is both brittle and a maintenance tax.
//
// This target intentionally shares `source: 'phenom'` across tenants so
// rows merge cleanly in the DB.

const { CONFIG } = require('../config');
const log = require('../logger');

const TENANTS = [
  {
    slug: 'cisco',
    displayName: 'Cisco',
    url: 'https://careers.cisco.com/global/en/search-results?country=United+States+of+America',
    jobUrlPattern: /\/global\/en\/job\/(\d+)/,
    applyUrlPrefix: 'https://careers.cisco.com',
  },
  {
    slug: 'cognizant',
    displayName: 'Cognizant',
    url: 'https://careers.cognizant.com/global-en/jobs/',
    jobUrlPattern: /\/global-en\/jobs\/(\d+)/,
    applyUrlPrefix: 'https://careers.cognizant.com',
  },
];

function looksUSCandidate(locationText) {
  if (!locationText) return true; // no location visible = don't pre-drop
  const l = locationText.toLowerCase();
  if (/\b(united states|usa|\bu\.s\.a?\b)\b/.test(l)) return true;
  if (/\b(remote|anywhere|multiple\s+locations)\b/.test(l) && !/\bemea|apac|europe|asia|india|uk|canada|\bindia\b/.test(l)) return true;
  return /\b(california|new york|washington|texas|massachusetts|illinois|georgia|colorado|virginia|pennsylvania|north carolina|new jersey|maryland|michigan|minnesota|florida|ohio|oregon|arizona|utah|tennessee|missouri|san francisco|san jose|seattle|boston|austin|chicago|atlanta|denver|portland|san diego|palo alto|mountain view|sunnyvale|bellevue|cambridge|brooklyn|houston|dallas|minneapolis|redmond)\b/.test(l);
}

async function scrapeTenant(context, tenant) {
  const page = await context.newPage();
  try {
    await page.goto(tenant.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});
    await page.waitForTimeout(3500);

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
  } catch (err) {
    log.warn('target.phenom.fail', { tenant: tenant.slug, error: err.message });
    return [];
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function run(context) {
  const all = [];
  for (const tenant of TENANTS) {
    const rows = await scrapeTenant(context, tenant);
    all.push(...rows);
  }
  return all;
}

module.exports = { run, source: 'phenom' };
