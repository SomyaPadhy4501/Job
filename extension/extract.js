'use strict';

// Generic job extractor — turns whatever JSON a careers page loads into rows
// for /admin/ingest. No per-company code: it looks for the SHAPE of a job list.
//
//   1. Walk the JSON (depth-limited) and collect every array of objects.
//   2. Score each array: how many items carry a title-like key AND an id or
//      url? A real job list scores ~1.0; navigation menus, filters and
//      facet counts score near 0 (they have labels but no id/url pairing, or
//      are too short).
//   3. Map each item of a winning array by trying the common key names each
//      ATS uses (title / jobTitle / text / name / t …).
//
// Also reads schema.org JobPosting JSON-LD, which many career sites embed for
// Google. Loaded both by the content script (browser) and by Node tests, hence
// the UMD-style export at the bottom.

(function (root) {
  const TITLE_KEYS = ['title', 'jobTitle', 'job_title', 'postingTitle', 'jobOpeningName', 'positionName', 'position', 'text', 'name', 't'];
  const ID_KEYS = ['id', 'jobId', 'job_id', 'jobID', 'requisitionId', 'reqId', 'req_id', 'shortcode', 'guid', 'uuid', 'externalId', 'jobReqId', 'eid'];
  const URL_KEYS = ['absolute_url', 'job_path', 'applyUrl', 'apply_url', 'hostedUrl', 'jobUrl', 'job_url', 'url', 'canonicalPositionUrl', 'postingUrl', 'detailUrl', 'link', 'href', 'externalPath', 'externalUrl', 'shortlink'];
  const LOCATION_KEYS = ['location', 'locationName', 'locations', 'locationsText', 'jobLocation', 'primaryLocation', 'city', 'workLocation', 'atsLocation', 'fullLocation', 'l', 'loc'];
  const DATE_KEYS = ['datePosted', 'date_posted', 'postedOn', 'postedDate', 'posted_at', 'publishedAt', 'published_at', 'published_on', 'first_published_at', 'releasedDate', 'createdAt', 'created_at', 'created', 'updated_at', 'updatedAt', 't_update', 't_create'];
  const DESC_KEYS = ['description', 'descriptionHtml', 'content', 'jobDescription', 'job_description', 'body', 'summary'];

  const MIN_ITEMS = 3;
  const MIN_SCORE = 0.7;
  const MAX_DEPTH = 9;

  function pick(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return undefined;
  }

  function str(v) {
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  }

  // Locations come as a string, a {city,state,country} object, an array of
  // either, or a nested {name}. Flatten to "City, State, Country".
  // Workday's "2 Locations" / "Multiple Locations" says nothing about where
  // the job is; treated as missing so the row is dropped rather than assumed US.
  const PLACEHOLDER_LOCATION = /^(?:\d+|multiple|several|various)\s+locations?$/i;

  function locationText(v, depth = 0) {
    if (v == null || depth > 3) return '';
    if (typeof v === 'string') return PLACEHOLDER_LOCATION.test(v.trim()) ? '' : v.trim();
    if (Array.isArray(v)) {
      const parts = v.map((x) => locationText(x, depth + 1)).filter(Boolean);
      // Prefer a US entry so the server's US filter sees it on multi-office roles.
      const us = parts.find((p) => /\b(us|usa|united states)\b|,\s*[A-Z]{2}$/i.test(p));
      return us || parts[0] || '';
    }
    if (typeof v === 'object') {
      if (typeof v.name === 'string' && v.name.trim() && !v.city) return v.name.trim();
      if (v.address) return locationText(v.address, depth + 1); // JSON-LD Place
      const city = v.city || v.addressLocality;
      const region = v.state || v.region || v.province || v.addressRegion || v.stateName;
      const country = v.country || v.countryName || v.addressCountry || v.countryCode;
      return [city, region, typeof country === 'object' ? country?.name : country]
        .filter((x) => typeof x === 'string' && x.trim())
        .join(', ');
    }
    return '';
  }

  // Epoch seconds, epoch ms, ISO strings, or "3 days ago"-free plain dates.
  // Anything unparseable → null, and the server stamps first-seen instead.
  function dateText(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) && d.getFullYear() > 2000 ? d.toISOString() : null;
    }
    if (typeof v === 'string') {
      const d = new Date(v);
      return Number.isFinite(d.getTime()) && d.getFullYear() > 2000 ? d.toISOString() : null;
    }
    return null;
  }

  function resolveUrl(v, base) {
    const s = str(v);
    if (!s) return '';
    try {
      return new URL(s, base).toString();
    } catch {
      return '';
    }
  }

  function looksLikeJob(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const title = str(pick(o, TITLE_KEYS));
    if (!title || title.length < 3 || title.length > 200) return false;
    return pick(o, ID_KEYS) != null || !!str(pick(o, URL_KEYS));
  }

  function scoreArray(arr) {
    if (!Array.isArray(arr) || arr.length < MIN_ITEMS) return 0;
    const sample = arr.length > 60 ? arr.slice(0, 60) : arr;
    let hits = 0;
    for (const o of sample) if (looksLikeJob(o)) hits++;
    return hits / sample.length;
  }

  function collectArrays(node, depth, out, seen) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object') out.push(node);
      for (const x of node.length > 200 ? node.slice(0, 200) : node) collectArrays(x, depth + 1, out, seen);
      return;
    }
    for (const k of Object.keys(node)) collectArrays(node[k], depth + 1, out, seen);
  }

  // `ctx`: { pageUrl, company, findLink(token) } — findLink lets the browser
  // side recover a job's URL from the rendered page: when the JSON carries
  // only ids (Workable: id + shortcode), or only a path relative to some base
  // the page knows and we don't (Workday's externalPath omits the site name).
  function mapItem(o, ctx) {
    const job_title = str(pick(o, TITLE_KEYS));
    const ids = ID_KEYS.map((k) => str(o[k])).filter(Boolean);
    const id = ids[0] || '';
    const rawUrl = str(pick(o, URL_KEYS));
    let apply_url = '';
    if (rawUrl && !/^https?:\/\//i.test(rawUrl) && ctx.findLink) apply_url = ctx.findLink(rawUrl) || '';
    if (!apply_url) apply_url = resolveUrl(rawUrl, ctx.pageUrl);
    for (const candidate of ids) {
      if (apply_url || !ctx.findLink) break;
      apply_url = ctx.findLink(candidate) || '';
    }
    if (!apply_url && id) {
      const u = new URL(ctx.pageUrl);
      u.hash = `job-${id}`;
      apply_url = u.toString();
    }
    const desc = pick(o, DESC_KEYS);
    const company = o.company?.name || o.companyName || o.company_name || o.hiringOrganization?.name || ctx.company;
    return {
      external_id: `${new URL(ctx.pageUrl).hostname}:${id || apply_url}`,
      company_name: str(company) || ctx.company || '',
      job_title,
      location: locationText(pick(o, LOCATION_KEYS)),
      apply_url,
      description: typeof desc === 'string' ? desc : '',
      date_posted: dateText(pick(o, DATE_KEYS)),
    };
  }

  function extractFromJson(json, ctx) {
    const arrays = [];
    collectArrays(json, 0, arrays, new Set());
    const winners = arrays.filter((a) => scoreArray(a) >= MIN_SCORE);
    const out = [];
    for (const arr of winners) {
      for (const o of arr) if (looksLikeJob(o)) out.push(mapItem(o, ctx));
    }
    return out;
  }

  // schema.org JobPosting, as embedded in <script type="application/ld+json">.
  function extractFromJsonLd(blocks, ctx) {
    const out = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(visit);
      if (n['@graph']) visit(n['@graph']);
      const type = [].concat(n['@type'] || []);
      if (!type.includes('JobPosting')) return;
      out.push({
        external_id: `${new URL(ctx.pageUrl).hostname}:${str(n.identifier?.value || n.identifier) || n.url || ctx.pageUrl}`,
        company_name: str(n.hiringOrganization?.name) || ctx.company || '',
        job_title: str(n.title),
        location: locationText(n.jobLocation) || (n.jobLocationType === 'TELECOMMUTE' ? locationText(n.applicantLocationRequirements) || 'Remote' : ''),
        apply_url: resolveUrl(n.url, ctx.pageUrl) || ctx.pageUrl,
        description: str(n.description),
        date_posted: dateText(n.datePosted),
      });
    };
    for (const b of blocks) visit(b);
    return out;
  }

  // Rows the server can't use, or can't place: no title, no URL, or no
  // location. The last matters most — the server treats an empty location as
  // "maybe US" and keeps it, so a worldwide board would flood in non-US roles.
  function usable(rows) {
    const seen = new Set();
    return rows.filter((r) => {
      if (!r.job_title || !r.apply_url || !r.location) return false;
      if (seen.has(r.external_id)) return false;
      seen.add(r.external_id);
      return true;
    });
  }

  // Multi-tenant ATS boards name the employer in the URL, which beats page
  // metadata — og:site_name on these reads "Apply" (Workable) or "Jobs" (Ashby).
  //   apply.workable.com/huggingface   jobs.ashbyhq.com/openai
  //   jobs.lever.co/plaid              nvidia.wd5.myworkdayjobs.com/…
  function companyFromUrl(pageUrl) {
    let u;
    try { u = new URL(pageUrl); } catch { return ''; }
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    const cap = (x) => x ? x.charAt(0).toUpperCase() + x.slice(1) : '';
    if (/(^|\.)(workable\.com|ashbyhq\.com|lever\.co|greenhouse\.io|smartrecruiters\.com|gem\.com)$/.test(host) && seg) {
      return cap(seg.replace(/[-_]+/g, ' '));
    }
    if (/(myworkdayjobs|bamboohr|recruitee|pinpointhq|eightfold|avature)\./.test(host)) {
      return cap(host.split('.')[0]);
    }
    return '';
  }

  // "Careers at Netflix" → "Netflix"; generic labels → '' so a better source wins.
  function cleanSiteName(name) {
    const n = String(name || '').trim()
      .replace(/^(?:careers|jobs|work|life)\s+(?:at|with|@)\s+/i, '')
      .replace(/\s*[|\-–—]\s*(?:careers|jobs).*$/i, '')
      .replace(/\s+(?:careers|jobs)$/i, '')
      .trim();
    return /^(?:apply|jobs?|careers?|home|job board|search)$/i.test(n) ? '' : n;
  }

  // "careers.tesla.com" / "www.tesla.com" → "Tesla". Last resort.
  function companyFromHost(hostname) {
    const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
    const generic = new Set(['www', 'careers', 'jobs', 'apply', 'join', 'work', 'boards', 'job-boards', 'explore', 'en', 'us']);
    const ats = /(myworkdayjobs|greenhouse|lever|ashbyhq|smartrecruiters|workable|recruitee|pinpointhq|bamboohr|icims|avature|eightfold|oraclecloud|taleo|successfactors)/;
    const core = parts.length > 2 && ats.test(parts.slice(-2).join('.'))
      ? parts[0]
      : parts.filter((p) => !generic.has(p)).slice(-2, -1)[0] || parts[0] || '';
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : '';
  }

  const api = { extractFromJson, extractFromJsonLd, usable, companyFromHost, companyFromUrl, cleanSiteName, locationText, dateText, scoreArray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
