# Handoff — Job Aggregator

Read this first if you're a new agent (Claude, Codex, or human) picking up
this codebase. It exists so you don't have to re-derive context.

---

## What this is

Personal job aggregator for **Somya** (the owner). Pulls US-based,
entry-level and 1-2 YOE mid-level software/ML/AI/DS/DevOps roles from
~12 free public sources + an opt-in Playwright scraper. Surfaces them in a
lightweight web UI with role / level / sponsorship / search filters.

Last verified live state (2026-04-24): **3,144+ jobs across 10 sources**
(pre-`hn_hiring` snapshot: 3,144 / 9 sources). Entry≈1,464, Mid≈190,
Sponsorship-YES≈131, Sponsorship-NO≈93.

**Recently added (2026-04-24):**
- Source `hn_hiring` — HN "Who is hiring?" threads filtered by a maintained YC US-hiring allowlist. Only source with clean per-comment `date_posted`.
- `scripts/probe-yc-ats.js` — discovers YC companies that publish on Greenhouse/Lever/Ashby. Output is `scripts/yc-ats-discovered.txt`, waiting on Somya's review before rows get pasted into `src/config.js`.
- `HOSTING.md` — plan to move off local to Vercel + Neon Postgres + GitHub Actions (free tier, zero-ops).

---

## How to run everything

```bash
cd /Users/somya/Desktop/Job
./run-all.sh
```

That one command:
1. Picks a free port starting at 4000
2. Installs main + scraper deps if first run (Chromium is ~250 MB)
3. Starts the main API + scheduler (every 2 h collect)
4. Starts the Playwright scraper microservice (every 6 h)
5. Opens the browser to `http://localhost:<port>`
6. Streams interleaved logs with `[main]` and `[scr ]` prefixes
7. **Ctrl+C** stops both cleanly (verified)

Env overrides: `PORT`, `RUN_SCRAPER=false` (main only), `COLLECT_CRON`,
`SCRAPER_CRON`, `ENTRY_LEVEL_MODE`, `FILTER_US`, `FILTER_SOFTWARE`,
`COLLECT_TOKEN`.

Other ways to run individual pieces:
- `RUN_SCRAPER=false ./run-all.sh` — main service only (no Playwright)
- `npm run collect` — one-shot collect and exit (no API, no scheduler)
- `cd scraper && npm run scrape` — one-shot scrape and exit
- `cd scraper && npm run scrape:one -- meta` — scrape a single target (debug)

---

## User's priorities (ranked; don't re-litigate)

1. **US-based, full-time** (interns and co-ops are rejected globally in `normalize.js`; don't suggest re-enabling them)
2. **Entry-level OR mid-level (1-2 YOE)**. `II` is mid, `III`+ is senior. Senior/staff/principal/lead/manager/architect are rejected.
3. **Role types:** SWE/SDE, MLE, AI/Research, Data Scientist, Data Engineer, DevOps/SRE/Platform, Security, Mobile
4. **Visa sponsorship tracking.** Classifier is rule-based (`src/services/classifier.js`). Some sources pre-label sponsorship — their labels win over the classifier via `sponsorship_override`.
5. **Newest first.** Date sort with ISO normalization (`normalize.js::parseDateToIso`).
6. **Cadence:** main every 2 h, scraper every 6 h.

---

## Architecture

Two processes, isolated:

```
┌───────────────────────┐                    ┌───────────────────────┐
│  main service (Node)  │                    │  scraper/  (Node)     │
│  SQLite, Express, UI  │ ◀──── HTTP ──────  │  Playwright + cron    │
│  Always on            │  POST /admin/ingest│  Opt-in, fragile      │
└───────────────────────┘                    └───────────────────────┘
       ▲
       │ reads
       │
  data/jobs.db
```

If the scraper crashes, the main service doesn't notice. `run-all.sh` ties
them together at the process level only.

---

## File map (only the load-bearing ones)

### Main service (`/`)

| File | What it does |
|---|---|
| `src/index.js` | Entry: starts API + cron scheduler |
| `src/config.js` | Runtime config + the master list of companies |
| `src/db/index.js` | SQLite init, schema, migrations, queries |
| `src/api/server.js` | Express routes: `/jobs`, `/stats`, `/jobs/:id`, `/admin/collect`, `/admin/ingest`, static UI |
| `src/scheduler.js` | node-cron wrapper (single-flight guard) |
| `src/services/collect.js` | Orchestrator: fan out to collectors, normalize, upsert transactionally |
| `src/services/normalize.js` | Date parsing, US-location filter, role classifier, level filter, sponsorship override |
| `src/services/classifier.js` | Sponsorship rule classifier (NO precedence beats YES) |
| `src/services/dedupe.js` | In-batch dedupe helper |
| `src/collectors/http.js` | Shared fetch wrapper with timeout, retries, hostname-scoped TLS bypass, `runWithConcurrency` helper |
| `src/collectors/*.js` | One file per source (see next section) |
| `src/collectors/yc_companies.js` | **Shared utility** (not a collector). Fetches `akshaybhalotia/yc_company_scraper` feed, filters to `regions` contains "United States of America" + `isHiring: true`, exposes `loadUsHiringCompanies()` and `slugName()`. In-process cache — fetched once per `collectAll()` run. Used by `hn_hiring` and `scripts/probe-yc-ats.js`. |
| `frontend/index.html`, `styles.css`, `app.js` | Zero-dep static UI served by Express |

### Scraper service (`/scraper/`)

| File | What it does |
|---|---|
| `src/index.js` | Entry: starts scraper cron |
| `src/config.js` | INGEST_URL, cron, target list, Playwright knobs |
| `src/browser.js` | Shared Chromium launch/context |
| `src/ingest.js` | HTTP POST client → main `/admin/ingest` |
| `src/targets/_base.js` | Generic "navigate + intercept + extract" loop |
| `src/targets/{microsoft,apple,meta,google}.js` | Per-site target (responseMatcher + extract) |
| `src/debug-urls.js` | Diagnostic: lists every XHR URL seen during a page load, marks job-shaped JSON responses with `★ JOBS`. **This is how you fix a broken target.** |
| `src/scheduler.js` | node-cron (6 h default) + single-flight |
| `src/run-once.js`, `src/run-one.js` | Manual triggers (`npm run scrape`, `npm run scrape:one`) |

### Top level

| File | What it does |
|---|---|
| `run-all.sh` | **Unified launcher — what the user runs** |
| `README.md` | Project-level documentation (slightly stale re: cadence; defer to HANDOFF.md) |
| `HANDOFF.md` | This file |
| `HOSTING.md` | Target hosted-deployment plan (Vercel + Neon + GitHub Actions). Read if the user wants to move off local. |
| `scripts/probe-yc-ats.js` | One-shot: discovers YC US-hiring companies on Greenhouse/Lever/Ashby and prints copy-paste-ready config entries. See §Tools & Scripts. |
| `scripts/yc-ats-discovered.txt`, `.log` | Output + progress log of the most recent probe run. Regenerate by re-running the script. |

---

## Sources — per-source implementation status

All collectors return jobs in this common shape:
```
{ source, external_id, company_name, job_title, location,
  apply_url, description, date_posted,
  sponsorship_override?, entry_level_override?, mid_level_override? }
```

| Source | Type | Where | How |
|---|---|---|---|
| `greenhouse` | ATS API | `src/collectors/greenhouse.js` | Pull 25 companies from `boards-api.greenhouse.io` |
| `lever` | ATS API | `src/collectors/lever.js` | Pull 2 companies from `api.lever.co` |
| `ashby` | ATS API | `src/collectors/ashby.js` | Pull 8 companies from `api.ashbyhq.com` |
| `workday` | ATS API | `src/collectors/workday.js` | Pull 6 tenants (Nvidia/Adobe/PayPal/Salesforce/Intel/Walmart). Quirk: `total` only on page 1; we cap at 500/company. Description enrichment via per-job detail call, capped to 80/run. |
| `amazon` | Single-tenant | `src/collectors/amazon.js` | `amazon.jobs/en/search.json`, 9 role queries, deduped by id |
| `uber` | Single-tenant | `src/collectors/uber.js` | `uber.com/api/loadSearchJobsResults`. Has authoritative `level` field (3=entry, 4=mid, 5+=senior) — used for overrides |
| `microsoft` | Single-tenant | `src/collectors/microsoft.js` | `apply.careers.microsoft.com/api/pcsx/search`. 887 jobs. **Found via scraper's debug-urls.js** — replace endpoint if PCSX disappears |
| `netflix` | Single-tenant (Eightfold) | `src/collectors/netflix.js` | `explore.jobs.netflix.net/api/apply/v2/jobs`. L-level detection: L3=entry, L4=mid, L6+=reject |
| `ghlistings` | Curated GitHub JSON | `src/collectors/ghlistings.js` | Generic — URL per config entry. Currently wired to `vanshb03/New-Grad-2027` + `SimplifyJobs/New-Grad-Positions`. Pre-labeled sponsorship via `SPONSOR_MAP` |
| `hn_hiring` | HN Firebase + YC allowlist | `src/collectors/hn_hiring.js` | Walks last 2 "Who is hiring?" threads via `hacker-news.firebaseio.com`, parses `Company \| Role \| Location \| URL` headers, filters by the YC US-hiring allowlist fetched from `akshaybhalotia/yc_company_scraper` (see `src/collectors/yc_companies.js`). Only source with per-comment `time` → clean `date_posted`. Run `scripts/probe-yc-ats.js` to discover YC companies on Greenhouse/Lever/Ashby. |
| *(scraper)* `meta` | Playwright | `scraper/src/targets/meta.js` | DOM scraper on `metacareers.com/jobsearch` + detail pages under `/profile/job_details/*`. Last validated live run captured **26 raw rows** after query/team fan-out plus description-based seniority pruning. Not full pagination — breadth comes from multiple search views, then detail-page extraction. |
| *(scraper)* `apple` | Playwright | `scraper/src/targets/apple.js` | Matches `jobs.apple.com/api/*`. Currently captures 0 rows — API fires no job-list XHRs during our session (SPA is cookie-gated) |
| *(scraper)* `google` | Playwright | `scraper/src/targets/google.js` | DOM scraper on Google Careers search pages + job detail pages. Last validated live run captured **21 raw rows** after query fan-out, detail extraction, and description-based seniority pruning. No RPC decoding needed anymore. |

### Sources that are *intentionally* not implemented

| Company | Why not |
|---|---|
| LinkedIn | Paid API + ToS-gray. Won't ship. |
| Indeed | Cloudflare challenge on every request; actively litigates scrapers (Indeed v. Jobs with Us, 2021). Won't ship. |
| Glassdoor | Returns 403 immediately, same parent as Indeed. Won't ship. |
| Handshake | SSO-gated, per-user auth. Could be added as a "paste your session cookie" feature if asked explicitly. |
| workatastartup.com (official YC board) | No public JSON API. Key endpoints 404/redirect to login; data is gated behind a YC candidate session cookie. We get YC jobs via `hn_hiring` (HN "Who is hiring?" + YC allowlist) and via `scripts/probe-yc-ats.js` (YC companies on Greenhouse/Lever/Ashby). |
| TCS / Infosys | Custom closed ATSes (`ibegin.tcs.com` DNS unresolvable, Infosys uses Oracle Taleo). No public JSON search. |
| Cognizant | Workday tenant rejects anonymous CxS calls (HTTP 422 on every facet/site combination). |
| Cisco | Same as Cognizant — `cisco.wd1.myworkdayjobs.com` returns 422 anonymously. |
| Tesla direct | `tesla.com/cua-api/apps/careers/state` returns 403 (Cloudflare UA-filtered). We get Tesla via ghlistings instead (~68 rows). |

If the user asks for any of these again, check this list before re-investigating.

---

## Data model (SQLite)

```sql
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key     TEXT    NOT NULL UNIQUE,   -- lower(company)|lower(title)|lower(location) slugified
  source         TEXT    NOT NULL,
  external_id    TEXT,
  company_name   TEXT    NOT NULL,
  job_title      TEXT    NOT NULL,
  location       TEXT,
  apply_url      TEXT    NOT NULL,
  description    TEXT,                     -- HTML-stripped, truncated to 20k
  date_posted    TEXT,                     -- ISO 8601; parseDateToIso normalizes all formats
  sponsorship    TEXT    NOT NULL DEFAULT 'UNKNOWN',   -- YES | NO | UNKNOWN
  role_type      TEXT    NOT NULL DEFAULT 'OTHER',     -- SWE | MLE | AI | DS | DATA_ENG | SRE | SECURITY | MOBILE | OTHER
  is_entry_level INTEGER NOT NULL DEFAULT 0,
  is_mid_level   INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL
);

CREATE TABLE collection_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  companies_ok    INTEGER NOT NULL DEFAULT 0,
  companies_fail  INTEGER NOT NULL DEFAULT 0,
  jobs_inserted   INTEGER NOT NULL DEFAULT 0,
  jobs_updated    INTEGER NOT NULL DEFAULT 0,
  errors          TEXT
);
```

Migrations in `src/db/index.js::migrate()` are additive-only (ALTER TABLE ADD COLUMN). Don't do destructive migrations; keep adding.

Sort order on `GET /jobs`:
```
ORDER BY CASE WHEN date_posted IS NULL THEN 1 ELSE 0 END,
         date_posted DESC,
         first_seen_at DESC,
         id DESC
```
i.e. dated rows first, newest first, "no-date" rows sink to the bottom.

---

## Normalize pipeline (`src/services/normalize.js`)

For each raw job, in order:
1. Trim title/company/location/url
2. Strip HTML from description
3. Parse `date_posted` → ISO 8601 (handles "April 22, 2026", Unix seconds, Unix ms, existing ISO)
4. **Reject** if missing `company_name` / `job_title` / `apply_url`
5. Classify role (`classifyRole`) → **Reject** if `OTHER` and `FILTER_SOFTWARE=true`
6. Location — **Reject** if not US (and `FILTER_US=true`)
7. Level filter (`passesLevel`):
   - Always reject interns (`intern`, `internship`, `co-op`, `Summer 20XX`)
   - Reject `senior / sr / staff / principal / lead / director / manager / head of / VP / architect / III / IV / V / VI`
   - Note: **`II` is allowed through** (mid-level)
8. Classify sponsorship — but `raw.sponsorship_override` wins if present (`YES`/`NO`/`UNKNOWN`)
9. Flag `is_entry_level` (from override if present, else title regex)
10. Flag `is_mid_level` (from override, else regex on `II`, `Mid-level`, `1-2 years`, etc.) — never double-stamped with entry
11. Compute `dedupe_key = lower(company)|lower(title)|lower(location)` (slugified)

---

## Extension recipes

### Add a new Greenhouse/Lever/Ashby company
One line in `src/config.js`:
```js
{ source: 'greenhouse', slug: 'newco', displayName: 'New Co' }
```

### Add a new ATS entirely
1. `src/collectors/<name>.js` exporting `{ source, fetchCompany(company) }`
2. Register in `src/collectors/index.js`
3. Add entries with `source: '<name>'` to `src/config.js::COMPANIES`

### Add a new Workday tenant
```js
{ source: 'workday', slug: 'newco', tenant: 'newco', wd: '1', site: 'External_Career_Site', displayName: 'New Co' }
```
If you get HTTP 422, their tenant blocks anonymous access — give up, don't spend hours on headers.

### Add a new Playwright target
1. Use `scraper/src/debug-urls.js <url>` to discover the API endpoint
2. Look for `★ JOBS` lines — those are job-carrying responses
3. Create `scraper/src/targets/<slug>.js` with `responseMatcher` + `extract`
4. Register in `scraper/src/targets/index.js`
5. Add to `SCRAPER_TARGETS` env var (or default list in `scraper/src/config.js`)

### Fix a broken target
```bash
cd scraper
node src/debug-urls.js 'https://site.com/search?q=software+engineer'
```
Update the target's `responseMatcher` + `extract` to match the new endpoint.
That's how Microsoft went from "needs Playwright" to "direct API" — the
debug tool is the single most important diagnostic in this codebase.

### Add a new curated GitHub listings repo
One line in `src/config.js`:
```js
{ source: 'ghlistings', slug: 'some-slug', displayName: '...', url: 'https://raw.githubusercontent.com/.../listings.json' }
```
Only works if the repo uses the same JSON schema as `vanshb03/New-Grad-2027` (see `src/collectors/ghlistings.js` — it accepts `active`/`is_visible`/`sponsorship` fields).

### Discover more YC companies on Greenhouse/Lever/Ashby
Run the probe tool:
```bash
node scripts/probe-yc-ats.js                 # full run, ~3 min
node scripts/probe-yc-ats.js --limit=100     # quick sample
node scripts/probe-yc-ats.js > scripts/yc-ats-discovered.txt
```
It loads the YC US-hiring company list, probes each against the three ATS
public APIs with slug variants (YC slug, name-dashed, name-flat, website
domain stem), and prints config-ready lines grouped by ATS. Copy-paste the
rows you want into `src/config.js::COMPANIES`. **Does not auto-mutate config
— user reviews.** Duplicates from the upstream YC feed are deduped on
`(source, slug)`.

---

## Tools & Scripts

| File | What it does |
|---|---|
| `scripts/probe-yc-ats.js` | YC-company ATS discovery tool (see recipe above). Output shape: `{ source, slug, displayName }` blocks grouped by ATS. |
| `scraper/src/debug-urls.js` | Playwright-driven XHR logger. Loads a careers page and prints every non-static response with size/status/content-type; marks job-shaped JSON with `★ JOBS`. **This is the single most important diagnostic in this codebase — it's how you fix a broken Playwright target or discover a new direct-API endpoint (Microsoft PCSX was found this way).** Usage: `cd scraper && node src/debug-urls.js 'https://site.com/search?q=engineer'` |
| `scraper/src/run-once.js`, `run-one.js` | Manual scrape triggers. `npm run scrape` (all targets), `npm run scrape:one -- <slug>` (single target for debug). |

---

## Env vars (complete reference)

Every env var the code actually reads, grouped by process.

**Main service (`src/`):**
- `PORT` — HTTP listen port (default: `3000`; `run-all.sh` picks next free from 4000)
- `DB_PATH` — SQLite file (default: `./data/jobs.db`)
- `COLLECT_CRON` — scheduler cron (default: `0 */2 * * *`, every 2 h at :00)
- `RUN_ON_START` — fire a collect run on process start (default: `true`)
- `FILTER_US` — drop non-US rows in `normalize.js` (default: `true`)
- `FILTER_SOFTWARE` — drop `role_type === 'OTHER'` (default: `true`)
- `ENTRY_LEVEL_MODE` — `off` | `permissive` | `strict` (default: `permissive`)
- `COLLECT_TOKEN` — bearer for `/admin/collect` and `/admin/ingest` (default: none = open)
- `DEBUG` — verbose logger (default: quiet)

**Scraper service (`scraper/src/`):**
- `INGEST_URL` — POST target (default: `http://localhost:4000/admin/ingest`)
- `COLLECT_TOKEN` — same token as main, for ingest auth
- `SCRAPER_CRON` — cron (default: `30 */6 * * *`, every 6 h at :30 — **intentionally offset from main's :00 to avoid overlapping DB writes; don't re-sync**)
- `RUN_ON_START` — fire a scrape on start (default: `true`)
- `HEADLESS` — Chromium headless mode (default: `true`)
- `NAV_TIMEOUT_MS` — per-page timeout (default: `45000`)
- `TARGET_TIMEOUT_MS` — per-target overall timeout (default: `120000`)
- `MAX_PAGES`, `SCROLL_DELAY_MS` — pagination/scroll knobs
- `SCRAPER_TARGETS` — comma-separated slugs (default: `apple,meta,google`)

**run-all.sh:**
- `RUN_SCRAPER=false` — skip the scraper microservice (main only)
- All of the above (passed through)

---

## npm scripts

**Main (`package.json`):**
- `npm start` — starts API + cron scheduler (does NOT start the scraper)
- `npm run collect` — one-shot collect and exit (no API, no cron)
- `npm run init-db` — create/migrate the SQLite schema

**Scraper (`scraper/package.json`):**
- `npm start` — starts scraper with its own cron
- `npm run scrape` — one-shot scrape-all and exit
- `npm run scrape:one -- <slug>` — debug a single target (e.g. `meta`)
- `npm run install-browsers` — fetch the Chromium binary for Playwright

**Normal operation is `./run-all.sh`**, not any of these directly.

---

## API contract

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /stats` | Totals, by-source, by-role, by-sponsor, by-level, last run |
| `GET /jobs` | Paginated list. Query: `search`, `sponsorship`, `company`, `role`, `level`, `page`, `limit`. Legacy `entry=true` alias for `level=entry`. |
| `GET /jobs/:id` | Full row including description |
| `POST /admin/collect` | Trigger a collect run (optionally token-protected via `COLLECT_TOKEN` → `x-collect-token` header) |
| `POST /admin/ingest` | **Used by scraper.** Body: `{ source, jobs: [rawJob, ...] }`. Runs each through normalize + upsert. Same token protection. |

Response body for `GET /jobs`:
```json
{
  "data": [ {row...}, ... ],
  "pagination": { "page", "limit", "total", "totalPages" },
  "filters":    { "search", "sponsorship", "company", "role", "level" }
}
```
30s TTL cache (`src/api/cache.js`) on `/jobs`; cache is cleared after every collection run + every `/admin/ingest`.

---

## Intentional decisions (don't second-guess without asking)

- **SQLite, not Postgres.** Single-user tool, zero-ops.
- **Rule-based sponsorship classifier, not an LLM.** Deterministic, free, good enough. Override from curated sources wins.
- **Playwright scraper opt-in, not default.** Fragile by nature. `run-all.sh` starts it by default; set `RUN_SCRAPER=false` to skip.
- **No LinkedIn / Indeed / Glassdoor.** Legal / ToS hostility.
- **No headless Chromium stealth plugins.** Not worth the arms race for a personal tool.
- **Hostname-scoped TLS bypass** in `src/collectors/http.js` (currently dormant but available for future use). Do NOT set `NODE_TLS_REJECT_UNAUTHORIZED=0` globally.
- **Dedupe by company|title|location, not by external_id.** Same role from multiple sources (e.g. Nvidia appears in both Workday and ghlistings) merges into one row.
- **`II` is mid-level, not senior.** At most companies it means 1-3 YOE. Matches Somya's target range.
- **YC coverage is dual-path, not single-source.** `hn_hiring` gets the dated-but-narrow feed (HN "Who is hiring?" filtered to US YC companies); the ATS probe tool expands the main collector list to include many more YC companies directly from Greenhouse/Lever/Ashby. workatastartup.com is not usable (no public API). Don't re-investigate.
- **HN "Who is hiring?" comment parsing drops most rows deliberately.** From ~670 top-level comments/month we keep ~15–20 after: (a) YC allowlist filter, (b) "Company | Role | Location | URL" header format requirement, (c) role-keyword requirement (no generic "Engineer" fallback — would false-match sales/BD "Engineers"), (d) foreign-location early reject. Low yield is a feature, not a bug.
- **Cache is manually cleared on writes.** `src/api/cache.js` is not event-driven; any new mutation endpoint must call `jobsCache.clear()` explicitly.

---

## Known issues (not blockers, just context)

- **Canadian cities like "Vancouver, BC, CA"** sometimes pass the US filter because `ca` matches California's state code. Low impact (handful of Workday rows); fix is to tighten `looksUS()` to look at position.
- **Microsoft descriptions are empty.** The list endpoint (`/api/pcsx/search`) doesn't include them — we'd need a per-job `/api/pcsx/position_details` call which would be 10× traffic. Sponsorship for MS rows will always be UNKNOWN unless fixed.
- **Netflix L5/L6 titles without the word "senior"** aren't rejected by the general senior-reject regex. The Netflix target has its own level filter (`L6+ reject`), but older collected rows may linger. Re-collect if needed.
- **Apple Playwright target still returns 0 rows.**
- **Google scraper is now DOM-based** and returned 21 raw rows in the last live validation.
- **Meta scraper is now DOM-based** and returned 26 raw rows in the last live validation. It still does not walk true pagination; coverage comes from multiple search views.
- **`hn_hiring` yield is intentionally low** (~12 rows net after the first live run). Most HN comments don't match the YC allowlist; among those that do, many use non-standard headers or post foreign-remote roles. This is the accepted tradeoff for getting real `date_posted` from HN vs nothing from workatastartup.com.
- **YC allowlist depends on a third-party feed** (`akshaybhalotia/yc_company_scraper`). It's actively maintained (monthly cadence, last commit 2026-04-13 as of this writing), but if it ever stops updating, `hn_hiring` and `scripts/probe-yc-ats.js` both silently lose coverage. There's no fallback; you'd switch to `yc-oss/api` or roll your own from YC's public Algolia index.
- **Probe-tool output is a snapshot, not a feed.** `scripts/yc-ats-discovered.txt` reflects the state at the moment it was run. Re-run monthly or whenever the YC feed refreshes.

---

## Running tests / verifying state

There's no test suite — the project favors live verification. To verify a change:

```bash
# Wipe + full collect
rm -rf data/ && npm run init-db && npm run collect

# Check DB counts
node -e "const db=require('better-sqlite3')('./data/jobs.db'); console.log('total:', db.prepare('SELECT COUNT(*) c FROM jobs').get().c)"

# Check API response
curl -s 'http://localhost:4000/jobs?role=MLE&level=mid&limit=5' | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).pagination))'

# Scrape a single target (debug)
cd scraper && node src/run-one.js meta
```

---

## Where to pick up next (ranked by value)

### Immediately actionable (tonight)

1. **Integrate the YC ATS probe output.** The most recent run of `scripts/probe-yc-ats.js` discovered several hundred new YC US-hiring companies across Greenhouse, Lever, and Ashby (numbers in `scripts/yc-ats-discovered.log`). Open `scripts/yc-ats-discovered.txt`, review the lines, and paste the ones you recognize into `src/config.js::COMPANIES`. **Expect some false positives** from the domain-stem slug variant (single-word hostnames like "14" may hit an unrelated Greenhouse board). Eyeball each before adding. This is the single biggest yield jump available.
2. **Monitor the first few `hn_hiring` cron runs.** It's a new source and HN comment conventions drift. If yield drops to 0 one month, inspect with `node src/collectors/hn_hiring.js` in a REPL and compare first-line formats to the regex in `parseComment()`.

### Scraper coverage

3. **Add true Meta pagination.** The DOM scraper now gets substantially more rows, but still only from the first result page of several search views. If you can drive the pager safely, this is the biggest remaining scraper win.
4. **Add true Google pagination depth or narrower query packs.** Current DOM pass fans out across role queries and two pages/query. Tuning that tradeoff could improve freshness vs coverage.
5. **Apple Playwright target.** Currently returns 0 rows. Run `cd scraper && node src/debug-urls.js 'https://jobs.apple.com/en-us/search?search=software%20engineer'` and check for `★ JOBS` lines. If the SPA stays cookie-gated, consider rejecting Apple as intentionally-not-implemented.

### Normalize pipeline

6. **Tighten US location filter.** Strip out `Vancouver, BC, CA` false positives (the bare `ca` token currently matches California's state code).
7. **"Posted in last N days" filter.** User hinted at this earlier. Easy — another URL param + WHERE clause + UI dropdown.
8. **Microsoft description enrichment.** Per-job `/api/pcsx/position_details` call for the top 50–100 filtered positions. Would light up sponsorship for MS rows.

### Platform / hosting (blocked on Somya's decision)

9. **Migrate to the hosted architecture in `HOSTING.md`.** Vercel (frontend + read API) + Neon Postgres (DB) + GitHub Actions (2h collect cron + 6h scrape cron). Zero-cost, zero-ops. Biggest mechanical change is porting `src/db/index.js` from `better-sqlite3` to `pg`. See HOSTING.md for the full checklist and open questions.

---

## Don't (red lines)

- Don't re-try Indeed / Glassdoor / LinkedIn. Legal + ToS. The user has been told this.
- Don't globally set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Don't add features the user didn't ask for. They've been specific.
- Don't add interns. The user explicitly rejected them.
- Don't add senior/staff/principal titles. Level filter is load-bearing.
- Don't write tests unless the user asks — they haven't.
- Don't delete `scraper/src/debug-urls.js`. It's a shipped diagnostic, not dev scaffolding.
- Don't try workatastartup.com again. No public API, endpoints 404 / gate on YC candidate session. `hn_hiring` + the ATS probe cover YC.
- Don't auto-paste `scripts/yc-ats-discovered.txt` into `src/config.js` without review. The probe uses loose slug variants (including bare domain stems) that can false-match; every entry needs a human eyeball.
- Don't re-sync main and scraper cron (`0 */2 *` and `30 */6 *`). The 30-min offset is intentional — prevents overlapping DB writes.
