'use strict';

// Built In hides the employer's own link. Its Apply button points at
// `/job/{slug}/{id}?handler=ApplyRedirect`, which sends a signed-out visitor
// (the scraper always is) to `?applyRequired=true`, a Built In sign-in prompt,
// instead of the company site (checked 2026-11-24). So this step finds the
// same posting on the employer's own board and uses that link instead:
//
//   1. The company is one of ours (src/config.js) on Greenhouse, Lever, Ashby
//      or Workday: read that board (Workday: search it for the title).
//   2. Otherwise try the company name as a Greenhouse / Lever / Ashby slug
//      ("Capital One" -> capitalone, capital-one).
//
// A posting counts as the same job when its title matches exactly (after
// normalizeTitle). On a guessed slug the location must also share a city, or
// both be remote: a "Mercury" board that is not Mercury still lists a
// "Software Engineer". Unmatched rows keep their Built In link.
//
// A matched row takes the board's link, location and description, so it is
// the same row the employer's own collector stores: the upsert finds it by
// link and the board shows one copy, not two.

const { runWithConcurrency } = require('../../../src/collectors/http');
const greenhouse = require('../../../src/collectors/greenhouse');
const lever = require('../../../src/collectors/lever');
const ashby = require('../../../src/collectors/ashby');
const workday = require('../../../src/collectors/workday');
const { COMPANIES } = require('../../../src/config');
const log = require('../logger');

const LISTING = { greenhouse, lever, ashby };
const CONCURRENCY = 6;
const LEGAL_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|plc|lp|holdings)\b\.?/g;

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugGuesses(name) {
  const n = normalizeName(name);
  if (!n) return [];
  return [...new Set([n.replace(/ /g, ''), n.replace(/ /g, '-')])];
}

// "San Francisco, CA, USA" -> "san francisco"; Workday "McLean, VA" -> "mclean".
function cityOf(location) {
  return normalizeName(String(location || '').split(',')[0]);
}

function sharesPlace(builtinLocation, boardLocation) {
  const city = cityOf(builtinLocation);
  const board = normalizeName(boardLocation);
  if (!board) return false;
  if (/\bremote\b/.test(board) && /\bremote\b/i.test(builtinLocation || '')) return true;
  return !!city && board.includes(city);
}

// Our configured boards by normalized company name.
let byName;
function configuredBoards(name) {
  if (!byName) {
    byName = new Map();
    for (const c of COMPANIES) {
      const k = normalizeName(c.displayName || c.slug);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    }
  }
  return byName.get(normalizeName(name)) || [];
}

// Several postings can share a title (one per city); prefer the one in the
// Built In row's city.
function pick(candidates, row, requirePlace) {
  const near = candidates.filter((c) => sharesPlace(row.location, c.location));
  if (near.length) return near[0];
  return requirePlace ? null : candidates[0] || null;
}

// Workday: one title search per row instead of listing a tenant of thousands.
async function matchWorkday(board, rows) {
  const out = new Map();
  for (const row of rows) {
    const want = normalizeTitle(row.job_title);
    let items;
    try {
      // eslint-disable-next-line no-await-in-loop
      ({ items } = await workday.fetchPages(board, row.job_title, 20));
    } catch (err) {
      log.debug('builtin.resolve.workday-fail', { company: board.displayName, error: err.message });
      return out;
    }
    const hits = items
      .filter((j) => normalizeTitle(j.title) === want)
      .map((j) => ({ ...j, location: workday.resolveLocation(j) }));
    const hit = pick(hits, row, false);
    if (!hit) continue;
    // eslint-disable-next-line no-await-in-loop
    const description = await workday.fetchDetail(board, hit.externalPath).catch(() => '');
    out.set(row, {
      apply_url: workday.applyUrl(board, hit.externalPath),
      location: hit.location,
      description,
    });
  }
  return out;
}

// Greenhouse / Lever / Ashby: one request lists the whole board.
async function matchListing(board, rows, requirePlace) {
  const out = new Map();
  let jobs;
  try {
    jobs = await LISTING[board.source].fetchCompany(board);
  } catch {
    return out; // no such board (404) or it failed; try the next one
  }
  const byTitle = new Map();
  for (const j of jobs) {
    if (!j.apply_url) continue;
    const k = normalizeTitle(j.job_title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(j);
  }
  for (const row of rows) {
    const hit = pick(byTitle.get(normalizeTitle(row.job_title)) || [], row, requirePlace);
    if (hit) out.set(row, { apply_url: hit.apply_url, location: hit.location, description: hit.description });
  }
  return out;
}

async function resolveCompany(name, rows) {
  const found = new Map();
  const left = () => rows.filter((r) => !found.has(r));
  const merge = (m) => { for (const [r, v] of m) if (!found.has(r)) found.set(r, v); };

  const known = configuredBoards(name).filter((b) => LISTING[b.source] || b.source === 'workday');
  for (const board of known) {
    if (!left().length) break;
    // eslint-disable-next-line no-await-in-loop
    merge(board.source === 'workday' ? await matchWorkday(board, left()) : await matchListing(board, left(), false));
  }

  // Guess only for companies we don't track at all: one we track on another
  // system (Oracle, Eightfold, ...) has no Greenhouse board worth guessing at.
  if (!configuredBoards(name).length) {
    for (const slug of slugGuesses(name)) {
      for (const source of Object.keys(LISTING)) {
        if (!left().length) break;
        // eslint-disable-next-line no-await-in-loop
        merge(await matchListing({ source, slug, displayName: name }, left(), true));
      }
    }
  }
  return found;
}

// rows: Built In rows from builtin.js. Returns them with apply_url (and the
// board's location and description) replaced wherever the original was found.
async function resolveOriginalLinks(rows) {
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.company_name)) byCompany.set(r.company_name, []);
    byCompany.get(r.company_name).push(r);
  }

  const started = Date.now();
  const resolved = new Map();
  await runWithConcurrency([...byCompany], CONCURRENCY, async ([name, list]) => {
    try {
      for (const [r, v] of await resolveCompany(name, list)) resolved.set(r, v);
    } catch (err) {
      log.debug('builtin.resolve.company-fail', { company: name, error: err.message });
    }
  });

  log.info('builtin.resolve', {
    rows: rows.length,
    companies: byCompany.size,
    resolved: resolved.size,
    seconds: Math.round((Date.now() - started) / 1000),
  });

  return rows.map((r) => {
    const v = resolved.get(r);
    if (!v) return r;
    return {
      ...r,
      apply_url: v.apply_url,
      location: v.location || r.location,
      description: v.description || r.description,
    };
  });
}

module.exports = { resolveOriginalLinks, normalizeTitle, normalizeName, slugGuesses, sharesPlace };
