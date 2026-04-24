'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

const SEARCH_BASE =
  'https://www.google.com/about/careers/applications/jobs/results/';

const SEARCH_QUERIES = [
  'software engineer',
  'machine learning engineer',
  'research scientist',
  'data engineer',
  'data scientist',
  'site reliability engineer',
  'security engineer',
  'android engineer',
  'ios engineer',
];

const SEARCH_PAGE_LIMIT = 2;
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

function googleSearchUrl(query, pageNumber = 1) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('location', 'United States');
  url.searchParams.set('sort_by', 'date');
  if (pageNumber > 1) url.searchParams.set('page', String(pageNumber));
  return url.toString();
}

function normalizeDetailUrl(url) {
  const clean = String(url || '').split('#')[0];
  return clean.replace(/\?.*$/, '');
}

function extractExternalId(url) {
  const match = String(url || '').match(/\/results\/(\d+)/);
  return match ? match[1] : '';
}

function looksRelevantTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!/(engineer|scientist|developer|research)/.test(t)) return false;
  if (/\b(senior|staff|principal|lead|manager|director|head|vp|architect)\b/.test(t)) return false;
  if (/\b(iii|iv|v|vi)\b/.test(t)) return false;
  return true;
}

function parseGoogleCardLines(lines) {
  const title = lines[0] || '';
  const placeIndex = lines.indexOf('place');
  const levelIndex = lines.indexOf('bar_chart');

  let location = '';
  if (placeIndex >= 0) {
    const locationLines = [];
    for (let i = placeIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (
        line === 'bar_chart' ||
        line === 'Minimum qualifications' ||
        line === 'Learn more' ||
        line === 'share'
      ) {
        break;
      }
      locationLines.push(line);
    }
    location = locationLines.join(' ').replace(/\s*;\s*/g, '; ').trim();
  }

  const experienceLabel =
    levelIndex >= 0 && lines[levelIndex + 1]
      ? lines[levelIndex + 1]
      : '';

  return { title, location, experienceLabel };
}

function extractMaxYears(text) {
  const matches = [...String(text || '').matchAll(/\b(\d{1,2})\+?\s+years?\b/gi)];
  if (!matches.length) return null;
  return Math.max(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

function parseGoogleDescription(text) {
  const source = String(text || '');
  const startMarkers = [
    'Minimum qualifications:',
    'Minimum qualifications',
    'About the job',
  ];
  const endMarkers = [
    'Google is proud to be an equal opportunity and affirmative action employer.',
    'See also',
    'Privacy',
  ];

  let start = -1;
  for (const marker of startMarkers) {
    start = source.indexOf(marker);
    if (start >= 0) break;
  }
  if (start < 0) return '';

  let end = source.length;
  for (const marker of endMarkers) {
    const idx = source.indexOf(marker, start);
    if (idx >= 0 && idx < end) end = idx;
  }

  return source
    .slice(start, end)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function collectSearchSeeds(page, query) {
  const rows = [];

  for (let pageNumber = 1; pageNumber <= SEARCH_PAGE_LIMIT; pageNumber++) {
    const url = googleSearchUrl(query, pageNumber);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.navTimeoutMs,
    });
    await page.waitForTimeout(3500);

    const pageRows = await page.evaluate(() => {
      return Array.from(document.links)
        .filter((link) =>
          /\/about\/careers\/applications\/jobs\/results\/\d/.test(link.href)
        )
        .map((link) => {
          const card = link.closest('li');
          const text = (card?.innerText || link.innerText || '').trim();
          const lines = text
            .split('\n')
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return {
            href: link.href,
            lines,
          };
        })
        .filter((row) => row.href && row.lines.length);
    });

    let added = 0;
    for (const row of pageRows) {
      const href = normalizeDetailUrl(row.href);
      const parsed = parseGoogleCardLines(row.lines);
      if (!href || !looksRelevantTitle(parsed.title)) continue;
      rows.push({
        href,
        title: parsed.title,
        location: parsed.location,
        experienceLabel: parsed.experienceLabel,
      });
      added++;
    }

    if (!added) break;
  }

  return uniqueBy(rows, (row) => row.href);
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
      String(detail.title || '')
        .replace(/\s+—\s+Google Careers$/, '')
        .trim();
    const description = parseGoogleDescription(detail.text);
    const years = extractMaxYears(description);

    if (seed.experienceLabel === 'Advanced') return null;
    if (years != null && years > 3) return null;

    return {
      external_id: extractExternalId(seed.href),
      company_name: 'Google',
      job_title: title,
      location: seed.location,
      apply_url: seed.href,
      description,
      date_posted: null,
      entry_level_override:
        seed.experienceLabel === 'Early'
          ? 1
          : years != null && years <= 1
          ? 1
          : undefined,
      mid_level_override:
        seed.experienceLabel === 'Mid'
          ? 1
          : years != null && years >= 2 && years <= 3
          ? 1
          : undefined,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function run(context) {
  const page = await context.newPage();
  try {
    const seeds = [];
    for (const query of SEARCH_QUERIES) {
      const querySeeds = await collectSearchSeeds(page, query);
      log.info('target.google.search', { query, seeds: querySeeds.length });
      seeds.push(...querySeeds);
    }

    const uniqueSeeds = uniqueBy(seeds, (row) => row.href).slice(0, MAX_DETAIL_ROWS);
    const jobs = [];

    for (const seed of uniqueSeeds) {
      try {
        const job = await scrapeJobDetail(context, seed);
        if (job) jobs.push(job);
      } catch (err) {
        log.warn('target.google.detail-fail', { url: seed.href, error: err.message });
      }
    }

    return jobs.filter((job) => job.external_id && job.job_title && job.apply_url);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'google' };
