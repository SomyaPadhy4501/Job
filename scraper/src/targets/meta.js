'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

const SEARCH_URLS = [
  'https://www.metacareers.com/jobsearch',
  'https://www.metacareers.com/jobsearch?q=Software',
  'https://www.metacareers.com/jobsearch?q=Machine+Learning',
  'https://www.metacareers.com/jobsearch?q=Data+Engineer',
  'https://www.metacareers.com/jobsearch?q=Production+Engineer',
  'https://www.metacareers.com/jobsearch?q=Research+Scientist',
  'https://www.metacareers.com/jobsearch?teams[0]=Artificial%20Intelligence',
  'https://www.metacareers.com/jobsearch?teams[0]=Infrastructure',
  'https://www.metacareers.com/jobsearch?teams[0]=Software%20Engineering',
  'https://www.metacareers.com/jobsearch?teams[0]=Research%20and%20Data',
];

const MAX_DETAIL_ROWS = 80;

function cleanLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function uniqueBy(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeDetailUrl(url) {
  return String(url || '').split('#')[0].replace(/\?.*$/, '');
}

function extractExternalId(url) {
  const match = String(url || '').match(/\/profile\/job_details\/(\d+)/);
  return match ? match[1] : '';
}

function looksRelevantTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!/(engineer|scientist|developer|research)/.test(t)) return false;
  if (/\b(senior|staff|principal|lead|leadership|manager|director|head|vp|architect)\b/.test(t)) return false;
  return true;
}

function parseMetaDescription(text) {
  const source = String(text || '');
  const startMarkers = ['Apply now', 'Apply'];
  const endMarkers = [
    'About Meta',
    'Equal Employment Opportunity',
    'View jobs',
  ];

  let start = -1;
  let startLen = 0;
  for (const marker of startMarkers) {
    start = source.indexOf(marker);
    if (start >= 0) {
      startLen = marker.length;
      break;
    }
  }

  if (start < 0) return '';
  start += startLen;

  let end = source.length;
  for (const marker of endMarkers) {
    const idx = source.indexOf(marker, start);
    if (idx >= 0 && idx < end) end = idx;
  }

  return source
    .slice(start, end)
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMaxYears(text) {
  const matches = [...String(text || '').matchAll(/\b(\d{1,2})\+?\s+years?\b/gi)];
  if (!matches.length) return null;
  return Math.max(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

async function collectSearchSeeds(page, url) {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navTimeoutMs,
  });
  await page.waitForTimeout(7000);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await page.waitForTimeout(1000);
  }

  const rows = await page.evaluate(() => {
    return Array.from(document.links)
      .filter((link) => /\/profile\/job_details\/\d+/.test(link.href))
      .map((link) => {
        const text = (link.innerText || '').trim();
        const lines = text
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .filter((line) => line !== '⋅');
        return {
          href: link.href,
          title: lines[0] || '',
          location: lines[1] || '',
        };
      })
      .filter((row) => row.href && row.title);
  });

  return uniqueBy(
    rows
      .map((row) => ({
        href: normalizeDetailUrl(row.href),
        title: row.title,
        location: row.location,
      }))
      .filter((row) => row.href && looksRelevantTitle(row.title)),
    (row) => row.href
  );
}

async function scrapeJobDetail(context, seed) {
  const page = await context.newPage();
  try {
    await page.goto(seed.href, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.navTimeoutMs,
    });
    await page.waitForTimeout(2500);

    const detail = await page.evaluate(() => {
      return {
        title: document.title || '',
        text: document.body.innerText || '',
      };
    });

    const title =
      seed.title ||
      cleanLines(detail.text).find((line) => line && line !== 'Jobs') ||
      String(detail.title || '').replace(/\s+—\s+Meta Careers$/, '').trim();
    const description = parseMetaDescription(detail.text);
    const years = extractMaxYears(description);

    if (years != null && years > 3) return null;

    return {
      external_id: extractExternalId(seed.href),
      company_name: 'Meta',
      job_title: title,
      location: seed.location,
      apply_url: seed.href,
      description,
      date_posted: null,
      entry_level_override: years != null && years <= 1 ? 1 : undefined,
      mid_level_override: years != null && years >= 2 && years <= 3 ? 1 : undefined,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function run(context) {
  const page = await context.newPage();
  try {
    const seeds = [];
    for (const url of SEARCH_URLS) {
      const urlSeeds = await collectSearchSeeds(page, url);
      log.info('target.meta.search', { url, seeds: urlSeeds.length });
      seeds.push(...urlSeeds);
    }

    const uniqueSeeds = uniqueBy(seeds, (row) => row.href).slice(0, MAX_DETAIL_ROWS);
    const jobs = [];

    for (const seed of uniqueSeeds) {
      try {
        const job = await scrapeJobDetail(context, seed);
        if (job) jobs.push(job);
      } catch (err) {
        log.warn('target.meta.detail-fail', { url: seed.href, error: err.message });
      }
    }

    return jobs.filter((job) => job.external_id && job.job_title && job.apply_url);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'meta' };
