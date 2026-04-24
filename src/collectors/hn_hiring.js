'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { loadUsHiringCompanies, slugName } = require('./yc_companies');

// Hacker News "Who is hiring?" monthly thread collector, filtered to YC companies
// that are US-based and currently hiring. The HN Firebase API is free, public,
// and — critically — exposes `time` (epoch seconds) per comment so we get a real
// date_posted, which workatastartup.com does not.
//
// Flow:
//   1. Fetch the `whoishiring` user's submitted threads
//   2. Keep the 2 most recent "Who is hiring?" ones (skip "Who wants to be hired?"
//      and "Freelancer?" threads)
//   3. For each thread, fetch every top-level comment
//   4. Parse the conventional first-line header: "Company | Location | Type | URL"
//   5. Match company against the YC US allowlist — drop non-matches
//   6. Return in the common collector shape; normalize.js handles the rest

const HN = 'https://hacker-news.firebaseio.com/v0';
const MAX_THREADS = 2;
const COMMENT_CONCURRENCY = 8;
const WHO_IS_HIRING_RE = /^Ask HN:\s*Who is hiring/i;

// Common HTML entities HN emits. normalize.js::stripHtml handles &amp;/&lt;/&gt;/
// &quot;/&#39; but not the numeric hex entities HN uses for apostrophes/slashes.
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#x3a;/gi, ':')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#x3f;/gi, '?')
    .replace(/&#x26;/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2d;/gi, '-')
    .replace(/&nbsp;/gi, ' ');
}

function firstLine(html) {
  if (!html) return '';
  // HN separates the header from the body with <p>. Take everything before it.
  const beforeP = html.split(/<p>/i)[0];
  const text = beforeP.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function extractFirstHref(html) {
  if (!html) return '';
  const m = html.match(/href="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : '';
}

function stripCompanyAnnotations(name) {
  return name
    .replace(/\s*\(\s*YC\s+[A-Z]?\d{2,4}\s*\)/gi, '')   // "(YC W22)", "(YC S2024)"
    .replace(/\s*\|\s*YC\s+[A-Z]?\d{2,4}\s*$/gi, '')
    .replace(/\s*,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.?)\s*$/i, '')
    .trim();
}

// Detect "not US" early so the collector can reject before handing the row to
// normalize.js — looksUS() is lenient with bare "Remote" and we want stricter
// semantics for HN comments (where "Remote" often means worldwide).
const FOREIGN_MARKERS =
  /\b(worldwide|global|anywhere|emea|apac|latam|europe|european|asia|asian|india|uk\b|united kingdom|germany|france|spain|portugal|netherlands|poland|canada|canadian|ontario|toronto|vancouver|brazil|mexico|argentina|australia|japan|singapore|israel|nigeria|egypt|china|turkey|dubai|berlin|london|paris|amsterdam|sydney|melbourne|bangalore|hyderabad|delhi|mumbai|tokyo|seoul|tel aviv)\b/i;

function looksForeign(location) {
  if (!location) return false;
  return FOREIGN_MARKERS.test(location);
}

// Pull a plausible role/title out of a segment. Requires a role-family
// keyword followed by engineer/developer/scientist/researcher within the
// same segment, so "Customer Success Engineer" and "Sales Engineer" don't
// slip through as SWE.
const ROLE_KEYWORDS =
  /\b(software|full[-\s]?stack|front[-\s]?end|back[-\s]?end|mobile|ios|android|embedded|systems|platform|infrastructure|devops|sre|site reliability|data|ml|machine learning|ai|research|applied|security|cloud|qa|test|web|product|founding|growth|forward[-\s]?deploy(?:ed)?|solutions|startup|generalist)\b[^|]*?\b(engineers?|developers?|scientists?|researchers?)\b/i;

function extractRole(segments) {
  for (const seg of segments) {
    const m = seg.match(ROLE_KEYWORDS);
    if (!m) continue;
    // Singularize trailing "Engineers/Developers/Scientists/Researchers" so
    // normalize.js::classifyRole (which uses `\bengineer\b` etc. with a hard
    // word boundary) can match. "Product engineers" -> "Product engineer".
    const title = m[0]
      .replace(/\s+/g, ' ')
      .replace(/\b(engineer|developer|scientist|researcher)s\b/i, '$1')
      .trim();
    return title;
  }
  return '';
}

const CITY_MARKERS =
  /\b(sf|nyc|bay area|silicon valley|boston|seattle|austin|chicago|atlanta|denver|miami|houston|dallas|portland|san francisco|san jose|palo alto|mountain view|new york|brooklyn|cambridge|los angeles|washington|dc)\b/i;
const MODALITY_MARKERS = /\b(remote|onsite|on[-\s]?site|hybrid)\b/i;

// Gather every location-ish segment and join them. A bare "Hybrid" segment
// without a city fails normalize.js::looksUS(), so we concatenate with any
// sibling segment that names a US city — producing "Hybrid NYC" which does
// pass looksUS.
function extractLocation(segments) {
  const picked = [];
  for (const seg of segments) {
    const isCity = CITY_MARKERS.test(seg) || /^[A-Z][a-zA-Z .]+,\s*[A-Z]{2}$/.test(seg.trim());
    const isModality = MODALITY_MARKERS.test(seg);
    if (isCity || isModality) picked.push(seg);
  }
  return picked.join(' | ');
}

// Parse one HN comment into a candidate job record, or null if we can't
// confidently extract a company or the company isn't in the YC US set.
function parseComment(comment, ycByName) {
  if (!comment?.text) return null;
  const header = firstLine(comment.text);
  if (!header) return null;

  // Most hiring comments use " | " as the delimiter. A minority use " - " or
  // just commas — we only handle the " | " case; others fall through and are
  // dropped, which is fine (yield tradeoff is accepted).
  const rawSegments = header.split('|').map((s) => s.trim()).filter(Boolean);
  if (rawSegments.length < 2) return null;

  const companyRaw = stripCompanyAnnotations(rawSegments[0]);
  if (!companyRaw) return null;

  const yc = ycByName.get(slugName(companyRaw));
  if (!yc) return null;

  // URL from any <a> href in the comment body, else a URL-ish segment.
  let apply_url = extractFirstHref(comment.text);
  if (!apply_url) {
    for (const seg of rawSegments) {
      const m = seg.match(/https?:\/\/\S+/);
      if (m) { apply_url = m[0]; break; }
    }
  }
  if (!apply_url && yc.website) apply_url = yc.website;
  if (!apply_url) return null;

  const location = extractLocation(rawSegments.slice(1)) || yc.all_locations || '';
  if (looksForeign(location)) return null;

  // Require an explicit role in the header — don't fall back to a generic
  // "Software Engineer" because non-engineering listings (BD, sales, ops)
  // would then be misclassified as SWE and sneak past normalize.js.
  const job_title = extractRole(rawSegments.slice(1));
  if (!job_title) return null;

  return {
    source: 'hn_hiring',
    external_id: `hn:${comment.id}`,
    // Trust the HN spelling for display. The YC lookup is a membership check,
    // not a canonicalizer — company aliases can cause YC.name to drift from
    // what the commenter actually posted.
    company_name: companyRaw,
    job_title,
    location,
    apply_url,
    description: comment.text,        // normalize.js strips HTML
    date_posted: comment.time ? comment.time * 1000 : null,
  };
}

async function pickHiringThreads() {
  const user = await fetchJson(`${HN}/user/whoishiring.json`);
  const submitted = Array.isArray(user?.submitted) ? user.submitted : [];

  const threads = [];
  for (const id of submitted) {
    if (threads.length >= MAX_THREADS) break;
    const item = await fetchJson(`${HN}/item/${id}.json`);
    if (item?.title && WHO_IS_HIRING_RE.test(item.title)) {
      threads.push(item);
    }
  }
  return threads;
}

async function fetchComments(kidIds) {
  const items = await runWithConcurrency(kidIds, COMMENT_CONCURRENCY, async (id) => {
    try {
      return await fetchJson(`${HN}/item/${id}.json`, { retries: 1 });
    } catch {
      return null;
    }
  });
  return items.filter((i) => i && !i.__error && !i.deleted && !i.dead && i.text);
}

async function fetchCompany() {
  const { byName } = await loadUsHiringCompanies();

  const threads = await pickHiringThreads();
  if (!threads.length) return [];

  const out = [];
  const seen = new Set();
  for (const thread of threads) {
    const kids = Array.isArray(thread.kids) ? thread.kids : [];
    const comments = await fetchComments(kids);
    for (const c of comments) {
      const job = parseComment(c, byName);
      if (!job) continue;
      if (seen.has(job.external_id)) continue;
      seen.add(job.external_id);
      out.push(job);
    }
  }
  return out;
}

module.exports = { fetchCompany, source: 'hn_hiring' };
