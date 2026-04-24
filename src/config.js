'use strict';

// Sample companies. Shape depends on source:
//   greenhouse / lever / ashby:  { source, slug, displayName }
//   workday:                     { source, slug, tenant, wd, site, displayName }
//   amazon / microsoft:          { source, displayName }  (single-tenant scrapers)
//
// Unknown/invalid entries just log a warning and are skipped — safe to over-include.
const COMPANIES = [
  // ─── Greenhouse ──────────────────────────────────────────────────────────
  { source: 'greenhouse', slug: 'stripe',      displayName: 'Stripe' },
  { source: 'greenhouse', slug: 'airbnb',      displayName: 'Airbnb' },
  { source: 'greenhouse', slug: 'robinhood',   displayName: 'Robinhood' },
  { source: 'greenhouse', slug: 'coinbase',    displayName: 'Coinbase' },
  { source: 'greenhouse', slug: 'figma',       displayName: 'Figma' },
  { source: 'greenhouse', slug: 'discord',     displayName: 'Discord' },
  { source: 'greenhouse', slug: 'instacart',   displayName: 'Instacart' },
  { source: 'greenhouse', slug: 'dropbox',     displayName: 'Dropbox' },
  { source: 'greenhouse', slug: 'anthropic',   displayName: 'Anthropic' },
  { source: 'greenhouse', slug: 'databricks',  displayName: 'Databricks' },
  { source: 'greenhouse', slug: 'cloudflare',  displayName: 'Cloudflare' },
  { source: 'greenhouse', slug: 'reddit',      displayName: 'Reddit' },
  { source: 'greenhouse', slug: 'pinterest',   displayName: 'Pinterest' },
  { source: 'greenhouse', slug: 'lyft',        displayName: 'Lyft' },
  { source: 'greenhouse', slug: 'datadog',     displayName: 'Datadog' },
  { source: 'greenhouse', slug: 'twilio',      displayName: 'Twilio' },
  { source: 'greenhouse', slug: 'asana',       displayName: 'Asana' },
  { source: 'greenhouse', slug: 'brex',        displayName: 'Brex' },
  { source: 'greenhouse', slug: 'mercury',     displayName: 'Mercury' },
  { source: 'greenhouse', slug: 'gitlab',      displayName: 'GitLab' },
  { source: 'greenhouse', slug: 'block',       displayName: 'Block (Square)' },
  { source: 'greenhouse', slug: 'affirm',      displayName: 'Affirm' },
  { source: 'greenhouse', slug: 'chime',       displayName: 'Chime' },
  { source: 'greenhouse', slug: 'scaleai',     displayName: 'Scale AI' },

  // ─── Lever ───────────────────────────────────────────────────────────────
  { source: 'lever', slug: 'palantir',  displayName: 'Palantir' },
  { source: 'lever', slug: 'spotify',   displayName: 'Spotify' },

  // ─── Ashby ───────────────────────────────────────────────────────────────
  { source: 'ashby', slug: 'posthog',      displayName: 'PostHog' },
  { source: 'ashby', slug: 'ramp',         displayName: 'Ramp' },
  { source: 'ashby', slug: 'linear',       displayName: 'Linear' },
  { source: 'ashby', slug: 'perplexity',   displayName: 'Perplexity' },
  { source: 'ashby', slug: 'elevenlabs',   displayName: 'ElevenLabs' },
  { source: 'ashby', slug: 'notion',       displayName: 'Notion' },
  { source: 'ashby', slug: 'openai',       displayName: 'OpenAI' },
  { source: 'ashby', slug: 'cursor',       displayName: 'Cursor' },

  // ─── Workday (big tech + enterprise) ─────────────────────────────────────
  { source: 'workday', slug: 'nvidia',     tenant: 'nvidia',     wd: '5',  site: 'NVIDIAExternalCareerSite', displayName: 'Nvidia' },
  { source: 'workday', slug: 'adobe',      tenant: 'adobe',      wd: '5',  site: 'external_experienced',    displayName: 'Adobe' },
  { source: 'workday', slug: 'paypal',     tenant: 'paypal',     wd: '1',  site: 'jobs',                    displayName: 'PayPal' },
  { source: 'workday', slug: 'salesforce', tenant: 'salesforce', wd: '12', site: 'External_Career_Site',    displayName: 'Salesforce' },
  { source: 'workday', slug: 'intel',      tenant: 'intel',      wd: '1',  site: 'External',                displayName: 'Intel' },
  { source: 'workday', slug: 'walmart',    tenant: 'walmart',    wd: '5',  site: 'WalmartExternal',         displayName: 'Walmart' },

  // ─── Single-tenant collectors ────────────────────────────────────────────
  { source: 'amazon',       displayName: 'Amazon' },
  { source: 'uber',         displayName: 'Uber' },
  { source: 'netflix',      displayName: 'Netflix' },
  // Microsoft: their new apply.careers.microsoft.com frontend fetches jobs
  // from a public /api/pcsx/search endpoint. No auth, no TLS workaround
  // needed — the earlier 404s were because we were targeting the wrong path.
  { source: 'microsoft',    displayName: 'Microsoft' },

  // ─── Community-curated GitHub new-grad lists ─────────────────────────────
  // These give us broad FAANG + enterprise coverage (Google, Apple, Meta,
  // Microsoft, Goldman Sachs, JP Morgan, SpaceX, Boeing, Lockheed, …) that
  // we can't reach through the companies' own career-site APIs.
  //
  // Same schema across both repos. Add more lists by dropping another entry.
  {
    source: 'ghlistings',
    slug: 'vanshb03-newgrad2027',
    displayName: 'vanshb03/New-Grad-2027',
    url: 'https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json',
  },
  {
    source: 'ghlistings',
    slug: 'simplify-newgrad',
    displayName: 'SimplifyJobs/New-Grad-Positions',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  },

  // ─── YC startups via HN "Who is hiring?" ─────────────────────────────────
  // Pulls the last 2 monthly threads, parses "Company | Location | … | URL"
  // headers, and keeps only comments whose company matches a US-based YC
  // company currently marked `isHiring` in akshaybhalotia/yc_company_scraper.
  { source: 'hn_hiring', displayName: 'HN Who is hiring (YC US)' },
];

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || './data/jobs.db',

  // Cron: every 2 hours at minute 0.
  collectCron: process.env.COLLECT_CRON || '0 */2 * * *',
  runOnStart: process.env.RUN_ON_START !== 'false',

  // Filters applied during collection. Toggle via env for quick iteration.
  filterUSOnly: process.env.FILTER_US !== 'false',
  filterSoftwareOnly: process.env.FILTER_SOFTWARE !== 'false',

  // Entry-level filter mode:
  //   'off'        – keep everything
  //   'permissive' – drop explicit senior/staff/principal/manager/II+ roles (DEFAULT)
  //   'strict'     – require an explicit entry-level signal (intern, new grad, I, associate…)
  entryLevelMode: process.env.ENTRY_LEVEL_MODE || 'permissive',

  requestTimeoutMs: 20_000,
  fetchConcurrency: 4, // parallel companies per run

  defaultPageSize: 50,
  maxPageSize: 200,
  cacheTtlMs: 30_000,
};

module.exports = { COMPANIES, CONFIG };
