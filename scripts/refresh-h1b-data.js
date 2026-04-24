'use strict';

/**
 * refresh-h1b-data.js
 *
 * Fetches the last 2 fiscal years of USCIS H-1B Employer Data Hub CSVs,
 * normalizes employer names via normSlug(), aggregates approvals, and writes
 * src/data/h1b-sponsors.json.
 *
 * Run manually once per quarter when USCIS releases new data:
 *   node scripts/refresh-h1b-data.js
 *   git diff src/data/h1b-sponsors.json   # sanity-check the diff
 *   git commit -am "refresh h1b sponsor data Q<n> <year>"
 *
 * Takes ~30 seconds. No API key required; CSVs are US government public domain.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, '../src/data');
const OUTPUT_FILE = path.join(DATA_DIR, 'h1b-sponsors.json');
const NUM_FY = 2; // last N fiscal years to pull

// USCIS H-1B Employer Data Hub — CSV per fiscal year.
// FY runs Oct 1 – Sep 30. FY2025 = Oct 2024 – Sep 2025.
// URL pattern confirmed from the official USCIS H-1B Employer Data Hub Files page:
//   https://www.uscis.gov/tools/reports-studies/h-1b-employer-data-hub-files
// Latest published FY is 2023 (as of Apr 2026); FY2024+ are not yet released.
function csvUrl(fy) {
  return `https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${fy}.csv`;
}

// ─── Normalization ───────────────────────────────────────────────────────────
// Mirrors the slug logic in normalize.js so lookups hit the same keys.
// Keep in sync with normCompany() in src/services/normalize.js.

const STOPWORDS = new Set(['the', 'and', 'or', 'of', 'for', 'in', 'to', 'a', 'an', 'at']);

function normSlug(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    // Strip corporate suffixes
    .replace(/\b(inc|llc|ltd|corp|co|pbc|gmbh|plc|bv|ag)\b\.?/g, ' ')
    // Strip anything that's not a letter, digit, or space
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .join('-');
}

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

// ─── CSV fetching ─────────────────────────────────────────────────────────────

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node.js job-aggregator' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        https.get(res.headers.location, (res2) => {
          if (res2.statusCode !== 200) {
            reject(new Error(`HTTP ${res2.statusCode} for ${url}`));
            return;
          }
          const chunks = [];
          res2.on('data', (c) => chunks.push(c));
          res2.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res2.on('error', reject);
        });
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────

// Parse the USCIS CSV. It has no BOM but may have quoted fields.
// Returns an array of objects keyed by the header row.
function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = vals[i] || ''; });
    return obj;
  });
}

// Simple CSV field splitter — handles quoted fields with commas inside.
function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function probeLatestAvailableFY() {
  const now = new Date();
  const currentFY = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  // USCIS publishes with a lag; probe from current FY downward until we get a 200.
  for (let fy = currentFY; fy >= currentFY - 3; fy--) {
    const url = csvUrl(fy);
    try {
      const res = await new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'node.js job-aggregator' } }, resolve)
          .on('error', () => resolve({ statusCode: 999 }));
      });
      if (res.statusCode === 200) return fy;
    } catch { /* try next */ }
  }
  throw new Error('Could not reach USCIS H-1B data hub — check network');
}

async function main() {
  // Probe to find the latest FY available
  const latestFY = await probeLatestAvailableFY();
  console.log(`Latest available FY on USCIS site: ${latestFY}`);
  // Pull that FY + the one before it (or same if only one available)
  const fyYears = latestFY - (NUM_FY - 1) <= 0 ? [latestFY] : [latestFY, latestFY - 1];

  console.log(`Fetching FY${fyYears.join(', ')} USCIS H-1B Employer Data Hub CSVs…`);

  // Fetch and parse all FY CSVs in parallel
  const fyData = await Promise.all(
    fyYears.map(async (fy) => {
      const url = csvUrl(fy);
      console.log(`  Downloading FY${fy}…`);
      const raw = await fetchCsv(url);
      const rows = parseCsv(raw);
      console.log(`  FY${fy}: ${rows.length} rows`);
      return { fy, rows };
    })
  );

  // Aggregate by normalized slug
  // Schema: { [slug]: { approvals_last_2fy: number, latest_fy: number } }
  const aggregate = {};

  for (const { fy, rows } of fyData) {
    for (const row of rows) {
      const employerName = row['Employer'] || '';
      const initialApprovals = parseInt(row['Initial Approval'] || '0', 10);
      const continuingApprovals = parseInt(row['Continuing Approval'] || '0', 10);
      const approvals = initialApprovals + continuingApprovals;

      if (!employerName || isNaN(approvals)) continue;

      let slug = normSlug(employerName);

      // Apply synonym map if exists
      if (SYNONYMS[slug]) slug = SYNONYMS[slug];

      // Amazon: aggregate across all Amazon subsidiaries under 'amazon' prefix
      // (catches amazon, amazon-web-services, amazon-devops, etc.)
      if (slug.startsWith('amazon')) slug = 'amazon';

      if (!aggregate[slug]) {
        aggregate[slug] = { approvals_last_2fy: 0, latest_fy: 0 };
      }
      aggregate[slug].approvals_last_2fy += approvals;
      if (fy > aggregate[slug].latest_fy) {
        aggregate[slug].latest_fy = fy;
      }
    }
  }

  // Prune entries below the threshold (saves space, reduces noise)
  const THRESHOLD = 1; // keep all; classifier applies >= 3 cutoff at runtime
  const pruned = Object.entries(aggregate).filter(([, v]) => v.approvals_last_2fy >= THRESHOLD);
  const sponsors = Object.fromEntries(pruned);

  // Sort keys for deterministic diffs
  const sorted = {};
  Object.keys(sponsors).sort().forEach((k) => { sorted[k] = sponsors[k]; });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2) + os.EOL);

  const totalSlugs = Object.keys(sorted).length;
  const totalApprovals = Object.values(sorted).reduce((s, v) => s + v.approvals_last_2fy, 0);
  console.log(`\nWrote ${OUTPUT_FILE}`);
  console.log(`  Companies: ${totalSlugs}`);
  console.log(`  Total approvals (last ${NUM_FY} FY): ${totalApprovals.toLocaleString()}`);
  console.log(`  Top 10 by approvals:`);
  const top10 = Object.entries(sorted)
    .sort(([, a], [, b]) => b.approvals_last_2fy - a.approvals_last_2fy)
    .slice(0, 10);
  for (const [slug, v] of top10) {
    console.log(`    ${slug}: ${v.approvals_last_2fy.toLocaleString()} (FY${v.latest_fy})`);
  }
}

main().catch((err) => {
  console.error('refresh-h1b-data failed:', err.message);
  process.exit(1);
});
