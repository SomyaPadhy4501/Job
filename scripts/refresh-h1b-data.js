'use strict';

/**
 * refresh-h1b-data.js
 *
 * Downloads the last 2 fiscal years of the USCIS H-1B Employer Data Hub,
 * normalizes employer names via normSlug(), sums approvals, and writes
 * src/data/h1b-sponsors.json.
 *
 * Run manually once per quarter when USCIS updates the hub:
 *   node scripts/refresh-h1b-data.js
 *   git diff --stat src/data/h1b-sponsors.json   # sanity-check the diff
 *   git commit -am "refresh h1b sponsor data Q<n> <year>"
 *
 * Options (rarely needed):
 *   --fy=2022,2023   pull these fiscal years instead of the latest two
 *   --out=<file>     write somewhere other than src/data/h1b-sponsors.json
 *
 * Takes ~1 minute (about 100 MB per fiscal year). No API key required; the
 * data is US government public domain.
 */

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { normSlug } = require('../src/services/classifier');

// ─── Config ──────────────────────────────────────────────────────────────────

const OUTPUT_FILE = path.resolve(__dirname, '../src/data/h1b-sponsors.json');
const NUM_FY = 2; // last N fiscal years to pull

// USCIS stopped publishing one CSV per fiscal year after FY2023 (the old files
// are at https://www.uscis.gov/archive/h-1b-employer-data-hub-files). Newer
// years exist only in the interactive hub,
//   https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub
// a Tableau dashboard whose "Crosstab View" button opens the H1BPublic view.
// Tableau serves any view as CSV when ".csv" is appended to its URL, and sets a
// filter from a query parameter named after the field. That field is literally
// "Fiscal Year   " with three trailing spaces: "Fiscal Year" is ignored without
// an error and the default year comes back, so readExport() checks every row.
//
// FY runs Oct 1 – Sep 30. FY2026 = Oct 2025 – Sep 2026.
const VIEW_URL = 'https://bigdataanalyticspub-sb.uscis.dhs.gov/views/H1BEmployerDataHub-Final/H1BPublic.csv';
const FY_FIELD = 'Fiscal Year   ';
function exportUrl(fy) {
  return `${VIEW_URL}?${encodeURIComponent(FY_FIELD)}=${fy}`;
}

// The export is long-format: one row per employer location and measure, twelve
// measures per employer (an approval and a denial count for each case type).
// The six approvals together are what the old files split into "Initial
// Approval" (new employment, new concurrent, change of employer) and
// "Continuing Approval" (continuation, change with same employer, amended).
const APPROVAL_MEASURES = new Set([
  'New Employment Approval',
  'Continuation Approval',
  'Change with Same Employer Approval',
  'New Concurrent Approval',
  'Change of Employer Approval',
  'Amended Approval',
]);

// ─── High-value synonym map ──────────────────────────────────────────────────
// USCIS sometimes lists the same company under multiple DBA names. Map the
// aliases we care about to their primary slug. Only entries where we have
// jobs in the DB need to be here.
//
// Format: { [alias]: primary_slug }
const SYNONYMS = {
  // Meta
  'facebook': 'meta',
  'facebook-inc': 'meta',
  'facebook-inc': 'meta',
  'meta-platforms-inc': 'meta',
  'meta-platforms': 'meta',
  // Amazon
  'amazon-com-services': 'amazon',
  'amazon-web-services': 'amazon',
  'amazon-com': 'amazon',
  'amazon-devops': 'amazon',
  'amazon-corporation': 'amazon',
  // Goldman
  'goldman-sachs': 'goldman-sachs',
  'goldman-sachs-group': 'goldman-sachs',
  // JPMorgan
  'jpmorgan-chase': 'jpmorgan',
  'jpmorgan-chase-bank': 'jpmorgan',
  // Microsoft
  'microsoft-corp': 'microsoft',
  'microsoft-inc': 'microsoft',
  'microsoft-corporation': 'microsoft',
  // Google
  'google-llc': 'google',
  'alphabet-inc': 'google',
  // Apple
  'apple-inc': 'apple',
  // NVIDIA
  'nvidia-corp': 'nvidia',
  'nvidia-corporation': 'nvidia',
  // Netflix
  'netflix-inc': 'netflix',
  // Deloitte
  'deloitte-consulting-llp': 'deloitte',
  'deloitte-lp': 'deloitte',
  'deloitte-and-touch': 'deloitte',
  'deloitte-tax-llp': 'deloitte',
  'deloitte-advisory': 'deloitte',
  // Phenom
  'phenom-inc': 'phenom',
  // Workday
  'workday-inc': 'workday',
  // Salesforce
  'salesforce-inc': 'salesforce',
  // Adobe
  'adobe-inc': 'adobe',
  // Oracle
  'oracle-america-inc': 'oracle',
  // Intel
  'intel-corp': 'intel',
  'intel-corporation': 'intel',
  // IBM
  'ibm-corp': 'ibm',
  // Cisco
  'cisco-systems-inc': 'cisco',
  'cisco-technology-inc': 'cisco',
  // Uber
  'uber-technologies-inc': 'uber',
  // Airbnb
  'airbnb-inc': 'airbnb',
  // Lyft
  'lyft-inc': 'lyft',
  // Stripe
  'stripe-inc': 'stripe',
  // Square
  'square-inc': 'square',
  // PayPal
  'paypal-holdings-inc': 'paypal',
  // Spotify
  'spotify-ab': 'spotify',
  'spotify-usa-inc': 'spotify',
  // Twitter / X
  'twitter-inc': 'twitter',
  'x-corp': 'twitter',
  // LinkedIn
  'linkedin-corp': 'linkedin',
  // Palantir
  'palantir-technologies-inc': 'palantir',
  // Databricks
  'databricks-inc': 'databricks',
  // Snowflake
  'snowflake-inc': 'snowflake',
  // MongoDB
  'mongodb-inc': 'mongodb',
  // Elastic
  'elastic-n-v': 'elastic',
  // GitHub
  'github-inc': 'github',
  // GitLab
  'gitlab-b-v': 'gitlab',
  // Twilio
  'twilio-inc': 'twilio',
  // Zendesk
  'zendesk-inc': 'zendesk',
  // Shopify
  'shopify-inc': 'shopify',
  // Atlassian
  'atlassian-corp-plc': 'atlassian',
  'atlassian-inc': 'atlassian',
  // Coinbase
  'coinbase-global-inc': 'coinbase',
  // Pinterest
  'pinterest-inc': 'pinterest',
  // Snap
  'snap-inc': 'snap',
  // Roblox
  'roblox-corp': 'roblox',
  // DoorDash
  'doordash-inc': 'doordash',
  // Instacart
  'instacart-inc': 'instacart',
  // Grubhub
  'grubhub-inc': 'grubhub',
  // Yahoo
  'yahoo-inc': 'yahoo',
  // Zoom
  'zoom-video-communications-inc': 'zoom',
  // Dropbox
  'dropbox-inc': 'dropbox',
  // Box
  'box-inc': 'box',
  // Okta
  'okta-inc': 'okta',
  // Cloudflare
  'cloudflare-inc': 'cloudflare',
  // Akamai
  'akamai-technologies-inc': 'akamai',
  // Fastly
  'fastly-inc': 'fastly',
  // Datadog
  'datadog-inc': 'datadog',
  // New Relic
  'new-relic-inc': 'new-relic',
  // Dynatrace
  'dynatrace-llc': 'dynatrace',
  // Sumo Logic
  'sumologic-inc': 'sumologic',
  // Splunk
  'splunk-inc': 'splunk',
  // HashiCorp
  'hashicorp-inc': 'hashicorp',
  'terraform-labs-inc': 'hashicorp',
  // VMware
  'vmware-inc': 'vmware',
  // Dell
  'dell-technologies-inc': 'dell',
  // Nutanix
  'nutanix-inc': 'nutanix',
  // Monday.com
  'monday-com-ltd': 'monday-com',
  // Wish
  'wish-technologies-inc': 'wish',
  // Yandex
  'yandex-llc': 'yandex',
  // Huawei
  'huawei-technologies-co-ltd': 'huawei',
  // ByteDance / TikTok
  'bytedance-inc': 'bytedance',
  'tiktok-inc': 'tiktok',
  // Tencent
  'tencent-technology-shenzhen-co-ltd': 'tencent',
  // Baidu
  'baidu-inc': 'baidu',
  // Alibaba
  'alibaba-group-holding-ltd': 'alibaba',
  // Huawei Device USA
  'huawei-device-usa-inc': 'huawei',
  // Lenovo
  'lenovo-group-ltd': 'lenovo',
  // Zoho
  'zoho-corp': 'zoho',
  // Freshworks
  'freshworks-inc': 'freshworks',
  // Talend
  'talend-sa': 'talend',
  // Autodesk
  'autodesk-inc': 'autodesk',
  // ServiceNow
  'servicenow-inc': 'servicenow',
  // Wipro
  'wipro-llc': 'wipro',
  'wipro-ltd': 'wipro',
  'wipro-appirio': 'wipro',
  // Anthropic
  'anthropic-anthropic': 'anthropic',
  // Turing
  'turing-com': 'turing',
  'turing-ai-inc': 'turing',
  // Capgemini
  'capgemini-american': 'capgemini',
  'capgemini-engineering': 'capgemini',
  // Leidos
  'leidos-innovations': 'leidos',
  // Northrop Grumman
  'northrop-grumman-systems': 'northrop-grumman',
  'northrop-grumman-c3': 'northrop-grumman',
  // RTX (Raytheon)
  'rtx-corp': 'rtx',
  'raytheon-company': 'rtx',
  // L3Harris
  'l3harris-technologies': 'l3harris-technologies',
  'l3harris': 'l3harris-technologies',
  // Emerson
  'emerson-electric': 'emerson-electric',
  'emerson-process-mgmt': 'emerson-electric',
  // Toyota
  'toyota-motor-north-america': 'toyota',
  'toyota-research-institute': 'toyota',
  // Walmart
  'walmart-labs': 'walmart',
  'walmart-inc': 'walmart',
  // Walt Disney
  'walt-disney-company': 'walt-disney-company',
  'disney': 'walt-disney-company',
  // Qualcomm
  'qualcomm-incorporated': 'qualcomm',
  // CACI
  'caci-international': 'caci',
  // Moog
  'moog-inc': 'moog',
};

// ─── CSV parsing ─────────────────────────────────────────────────────────────

// Incremental CSV reader: push() text as it arrives, end() at EOF. Quoted
// fields may hold commas ("ANYSPHERE, INC."), doubled quotes and newlines, and
// a field or quote may straddle two chunks.
function csvReader(onRecord) {
  let field = '';
  let record = [];
  let inQuotes = false;
  let quotePending = false; // inside quotes, the last char was a quote
  return {
    push(text) {
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
          if (quotePending) {
            quotePending = false;
            if (ch === '"') { field += '"'; continue; }
            inQuotes = false; // that quote closed the field; read ch below
          } else if (ch === '"') {
            quotePending = true;
            continue;
          } else {
            field += ch;
            continue;
          }
        }
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { record.push(field); field = ''; }
        else if (ch === '\n') { record.push(field); onRecord(record); record = []; field = ''; }
        else if (ch !== '\r') field += ch;
      }
    },
    end() {
      if (field || record.length) { record.push(field); onRecord(record); }
      field = '';
      record = [];
    },
  };
}

// Reads one fiscal year's export from an async iterable of byte chunks (a fetch
// body, a file stream). Returns Map<employer name, approvals>; empty when the
// year isn't published yet, which the server answers with a 1-byte body.
async function readExport(chunks, fy) {
  const totals = new Map();
  let cols = null;
  const reader = csvReader((rec) => {
    if (rec.length === 1 && !rec[0]) return; // blank line
    if (!cols) {
      const names = rec.map((h) => h.trim());
      cols = {
        employer: names.indexOf('Employer (Petitioner) Name'),
        fy: names.indexOf('Fiscal Year'),
        measure: names.indexOf('Measure Names'),
        value: names.indexOf('Measure Values'),
      };
      const missing = Object.keys(cols).filter((k) => cols[k] < 0);
      if (missing.length) throw new Error(`FY${fy}: export header lacks ${missing.join(', ')}: ${rec.join(',')}`);
      return;
    }
    const rowFy = Number(rec[cols.fy]);
    if (rowFy !== fy) {
      throw new Error(`asked for FY${fy} but the export holds FY${rec[cols.fy]} — the "${FY_FIELD}" filter was ignored`);
    }
    if (!APPROVAL_MEASURES.has(rec[cols.measure])) return;
    const name = rec[cols.employer].trim();
    const n = Number((rec[cols.value] || '0').replace(/,/g, ''));
    if (!name || !Number.isFinite(n) || n <= 0) return;
    totals.set(name, (totals.get(name) || 0) + n);
  });
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of chunks) reader.push(decoder.decode(chunk, { stream: true }));
  reader.push(decoder.decode());
  reader.end();
  return totals;
}

async function fetchExport(fy) {
  const res = await fetch(exportUrl(fy), {
    headers: { 'User-Agent': 'node.js job-aggregator' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${exportUrl(fy)}`);
  return readExport(res.body, fy);
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

// The hub spells some ampersands out ("AT AND T SERVICES INC"), and normSlug
// drops "at", "and" and lone letters, which leaves AT&T's 890 approvals under
// the key "services" (M&T Bank under "bank", S&P Global under "global"). Put
// the ampersand back wherever a lone letter sits beside the AND, so the name
// slugs the way the old files and job boards spell it: att-services.
const AND_BETWEEN_INITIALS = /\b([A-Z]{1,2}) AND ([A-Z]{1,2})\b/g;
function restoreAmpersands(name) {
  return name.replace(AND_BETWEEN_INITIALS, (m, a, b) => (a.length === 1 || b.length === 1 ? `${a}&${b}` : m));
}

// years: [{ fy, totals: Map<employer name, approvals> }]
// Schema: { [slug]: { approvals_last_2fy: number, latest_fy: number } }
function buildSponsors(years) {
  const aggregate = {};
  const add = (slug, approvals, fy) => {
    if (!aggregate[slug]) aggregate[slug] = { approvals_last_2fy: 0, latest_fy: 0 };
    aggregate[slug].approvals_last_2fy += approvals;
    if (fy > aggregate[slug].latest_fy) aggregate[slug].latest_fy = fy;
  };

  for (const { fy, totals } of years) {
    for (const [rawName, approvals] of totals) {
      const employerName = restoreAmpersands(rawName);
      // The hub keeps hyphens and periods the old CSVs turned into spaces
      // ("BRISTOL-MYERS SQUIBB", "LOB.COM INC"), and normSlug deletes them
      // without a space, so the legal name would only match postings that
      // punctuate it the same way. Index the spaced spelling as well, which is
      // what the old files produced — unless it shrinks to one word ("C-VISION
      // INC" → "vision"), the kind of key the prefix lookup in classifier.js
      // refuses to guess from.
      const candidates = [normSlug(employerName)];
      if (/[-.]/.test(employerName)) {
        const spaced = normSlug(employerName.replace(/[-.]/g, ' '));
        if (spaced.includes('-')) candidates.push(spaced);
      }
      const slugs = new Set();
      for (let slug of candidates) {
        if (!slug) continue;

        // Apply synonym map if exists
        if (SYNONYMS[slug]) slug = SYNONYMS[slug];

        // Amazon: aggregate across all Amazon subsidiaries under 'amazon' prefix
        // (catches amazon, amazon-web-services, amazon-devops, etc.)
        if (slug.startsWith('amazon')) slug = 'amazon';

        slugs.add(slug);
      }
      for (const slug of slugs) add(slug, approvals, fy);
    }
  }

  // Every employer with an approval is kept; the classifier applies its
  // USCIS_THRESHOLD at runtime. Keys sorted for deterministic diffs.
  const sorted = {};
  Object.keys(aggregate).sort().forEach((k) => { sorted[k] = aggregate[k]; });
  return sorted;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function argValue(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

// The newest NUM_FY published years, walking down from the current FY. A year
// USCIS hasn't published yet comes back empty, so this costs no extra download.
async function fetchLatestYears() {
  const now = new Date();
  const currentFY = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const years = [];
  for (let fy = currentFY; fy >= currentFY - 3 && years.length < NUM_FY; fy--) {
    console.log(`  Downloading FY${fy}…`);
    const totals = await fetchExport(fy);
    console.log(`  FY${fy}: ${totals.size ? `${totals.size} employers` : 'not published yet'}`);
    if (totals.size) years.push({ fy, totals });
  }
  if (!years.length) throw new Error('No fiscal year from the USCIS hub had data — check the view URL');
  return years;
}

async function main() {
  const out = argValue('out') ? path.resolve(argValue('out')) : OUTPUT_FILE;
  const pinned = argValue('fy');
  let years;
  if (pinned) {
    years = [];
    for (const fy of pinned.split(',').map(Number)) {
      console.log(`  Downloading FY${fy}…`);
      const totals = await fetchExport(fy);
      if (!totals.size) throw new Error(`FY${fy} is not published on the USCIS hub`);
      console.log(`  FY${fy}: ${totals.size} employers`);
      years.push({ fy, totals });
    }
  } else {
    console.log('Fetching the latest USCIS H-1B Employer Data Hub fiscal years…');
    years = await fetchLatestYears();
  }

  const sorted = buildSponsors(years);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n');

  const totalSlugs = Object.keys(sorted).length;
  // From the export, not the keys: brand and spaced keys repeat an employer.
  const totalApprovals = years.reduce((s, y) => s + [...y.totals.values()].reduce((a, b) => a + b, 0), 0);
  console.log(`\nWrote ${out} (FY${years.map((y) => y.fy).join(' + FY')})`);
  console.log(`  Companies: ${totalSlugs}`);
  console.log(`  Total approvals: ${totalApprovals.toLocaleString()}`);
  console.log(`  Top 10 by approvals:`);
  const top10 = Object.entries(sorted)
    .sort(([, a], [, b]) => b.approvals_last_2fy - a.approvals_last_2fy)
    .slice(0, 10);
  for (const [slug, v] of top10) {
    console.log(`    ${slug}: ${v.approvals_last_2fy.toLocaleString()} (FY${v.latest_fy})`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('refresh-h1b-data failed:', err.message);
    process.exit(1);
  });
}

module.exports = { readExport, buildSponsors, csvReader };
