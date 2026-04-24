# Handoff — Job Aggregator

Read this first if you're a new agent (Claude, Codex, or human) picking up
this codebase. It exists so you don't have to re-derive context.

---

## What this is

Personal job aggregator for **Somya** (the owner). Pulls US-based,
entry-level and 1-2 YOE mid-level software/ML/AI/DS/DevOps roles from
~12 free public sources + an opt-in Playwright scraper. Surfaces them in a
lightweight web UI with role / level / sponsorship / search filters.

Last verified live state (2026-04-24, post-retention + enterprise-pass):
**~2,900 jobs across 16 sources** (700 companies OK, 0 failures, runId 30).
Count is lower than the pre-retention 5,505 snapshot because the DB now
only holds rows posted (or last-seen) within the retention window — see
"Retention" below.

`COMPANIES` in `src/config.js` now holds **682 entries** after the YC ATS +
topstartups.io merges (up from ~47). Re-run `npm run collect` to pick up
the new coverage — the stats above were captured before the merge. First
collect after the merge also triggers a one-shot dedupe migration that
removes existing `apply_url` duplicates (kept oldest row, ran cleanly on
2026-04-24 removing 25 dupes).

**Recently added (2026-04-24):**
- Source `hn_hiring` — HN "Who is hiring?" threads filtered by a maintained YC US-hiring allowlist. Only source with clean per-comment `date_posted`.
- Source `oracle_hcm` — generic Oracle Recruiting Cloud / Candidate Experience collector. Verified live against Oracle (`careers.oracle.com`) and JPMorgan Chase (`jpmc.fa.oraclecloud.com`) on 2026-04-24.
- Enterprise-coverage pass (2026-04-24): added verified entries for DoorDash + HubSpot (Greenhouse), Cohere + Snowflake (Ashby), Accenture + Boeing + Capital One + Mastercard + Red Hat + Samsung + Morgan Stanley + GE HealthCare (Workday), Oracle + JPMorgan Chase (Oracle HCM), Qualcomm (PCSX), Capgemini (standalone). HubSpot is wired but currently normalizes to 0 rows — only `Principal Software Engineer` postings are open, rejected by the senior filter. All others yield 100–1,284 raw rows per run.
- Source `pcsx` — generic Phenom Cloud "PCSX" collector (`src/collectors/pcsx.js`). Same API shape as Microsoft's `/api/pcsx/search` but configurable via `{ apiBase, domain, applyUrlBase }` so the collector is reusable. Currently wired to Qualcomm (884 raw rows). Microsoft remains on its dedicated collector for legacy URL conventions.
- Source `capgemini` — standalone Azure-hosted API at `cg-jobstream-api.azurewebsites.net/api/job-search`. Paginates to Capgemini's full 6.5k-row global catalog; filter-to-`country_code === 'en-us'` pre-slice keeps ingestion to ~500 US rows. Note: Capgemini uses locale codes in `country_code`, **not** ISO 3166 — don't "fix" the `en-us` literal.
- Source `wipro` — Wipro's SAP-SuccessFactors-backed in-house API at `careers.wipro.com/services/recruiting/v1/jobs` (POST). Uses `location: "United States"` request param to narrow the 11k global catalog to ~663 US rows.
- Source `goldman_sachs` — Goldman Sachs's `api-higher.gs.com/gateway/api/v1/graphql` endpoint. Anonymous GraphQL; pulls all ~1.4k global roles and filters to US client-side (no reliable server-side location filter schema).
- Scraper target `deloitte` (`scraper/src/targets/deloitte.js`) — SSR DOM scrape of `apply.deloitte.com/en_US/careers/SearchJobs/?locationTextInput=United+States`. Paginates `?jobOffset=N` in 10-row steps, capped at 30 pages (~300 rows/run). No JSON API exists for Deloitte, so this is the only option. Lives in the scraper microservice because DOM selectors break on layout change — keeping it out of the main collector process insulates the rest.
- Scraper target `phenom` (`scraper/src/targets/phenom.js`) — generic Phenom People DOM scraper, shared across Cisco + Cognizant. Uses anchor-pattern selectors (`/global/en/job/{id}` for Cisco, `/global-en/jobs/{id}` for Cognizant) and falls back on visible DOM location text. Coverage is bounded: Phenom's infinite-scroll usually stalls around 10 visible results unless we click a specific "Show more" button that each tenant styles differently. Ships with the accepted limit; revisit if first-page coverage is insufficient.
- Retention: the DB now only holds jobs whose `date_posted` (or, if null, `last_seen_at`) is within `CONFIG.retentionDays` (default 30). Enforced at normalize time (old dated rows rejected) and again at the end of each collect run via `pruneStaleJobs()` in [src/db/index.js](src/db/index.js). Tunable via the `RETENTION_DAYS` env var.
- `scripts/probe-yc-ats.js` — discovers YC companies that publish on Greenhouse/Lever/Ashby. Writes config-ready blocks to stdout; redirect into a file for the verifier.
- `scripts/verify-yc-ats.js` — verifies probe output before merge (Greenhouse exact-name match via `/boards/{slug}` metadata; Lever/Ashby via slug-variant provenance). 12 collisions caught on the first run (e.g. `greenhouse:beam` → "Bridge to Enter Advanced Mathematics" nonprofit, not YC Beam). 357 entries verified and merged into `src/config.js` on 2026-04-24.
- `scripts/probe-topstartups.js` — discovers non-YC curated startups (Anduril, ClickHouse, Chainguard, Harvey, Abridge, Semgrep, …) from topstartups.io. Scrapes the infinite-scroll page, filters US-HQ, reuses the same ATS probe + name-match verification as the YC flow. 277 entries merged.
- `HOSTING.md` — plan to move off local to Vercel + Neon Postgres + GitHub Actions (free tier, zero-ops).

**Investigated and rejected (2026-04-24):**
- `startup.jobs` — Cloudflare 403 challenge on every endpoint (including RSS). Same bucket as LinkedIn/Indeed/Glassdoor.
- `thehub.io` — Nordic/Danish focus; near-zero US yield after `FILTER_US=true`.
- `theantijobboard.com` — not a listings site, landing page for a newsletter. No scrapeable jobs.
- `wellfound.com` — robots.txt explicitly disallows `/_jobs/`, `*?jobId=*`, `*?jobSlug=*`, `/job_listings/*`. ToS/legal red line; same bucket as LinkedIn.
- `builtin.com` — robots permissive but content Cloudflare-gated and US-tech startup coverage heavily overlaps with what we already get from Greenhouse/Lever/Ashby via the YC + topstartups probes. Not worth the effort given the duplicate-yield.

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
| `web/src/*` | **React UI (Vite + TanStack Query).** Single-page SPA built to `web/dist/` which Express serves statically. See §UI notes. |
| `web/dist/` | Built output — ~190 KB JS + 7 KB CSS, gzipped ~60 KB + 2 KB. Regenerated on demand by `run-all.sh` when `web/src/` is newer. |

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
| `scripts/probe-yc-ats.js` | One-shot: discovers YC US-hiring companies on Greenhouse/Lever/Ashby and prints copy-paste-ready config entries to stdout. See §Tools & Scripts. |
| `scripts/verify-yc-ats.js` | Verifier: for each entry in a probe-output file, confirms the ATS board belongs to the claimed YC company. Greenhouse: exact-name match on `/boards/{slug}` metadata. Lever/Ashby: provenance (slug must be derivable from YC name or website). Writes `scripts/yc-ats-verified.txt` (config-ready) and `scripts/yc-ats-rejected.txt` (with reason). |
| `scripts/probe-topstartups.js` | topstartups.io-sourced company discovery with built-in verification. Paginates the infinite-scroll homepage, filters US-HQ, probes Greenhouse/Lever/Ashby. Writes `scripts/topstartups-ats-discovered.txt` and `scripts/topstartups-ats-rejected.txt`. |

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
| `workday` | ATS API | `src/collectors/workday.js` | Pull a growing set of tenants (now includes Nvidia, Adobe, PayPal, Salesforce, Intel, Walmart, Accenture, Boeing, Capital One, Mastercard, Red Hat, Samsung). Quirk: `total` only on page 1; we cap at 500/company. Description enrichment via per-job detail call, capped to 80/run. |
| `oracle_hcm` | ATS API | `src/collectors/oracle_hcm.js` | Oracle Recruiting Cloud / Candidate Experience list API (`.../recruitingCEJobRequisitions`). Currently wired to Oracle + JPMorgan Chase. Public job detail URLs are deterministic from `uiBaseUrl + /job/{id}` so no browser needed. To add a new tenant, open the public careers page in DevTools, find the XHR to `{apiHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?...siteNumber={siteNumber}...`, then add `{ source: 'oracle_hcm', slug, displayName, apiHost, siteNumber, uiBaseUrl }` to `COMPANIES`. |
| `pcsx` | ATS API | `src/collectors/pcsx.js` | Generic Phenom Cloud PCSX collector — same shape as Microsoft's `/api/pcsx/search` but accepts `{ apiBase, domain, applyUrlBase }` per tenant. Currently wired to Qualcomm. To add a tenant, confirm the host exposes `/api/pcsx/search?domain={domain}&query=&start=0&num=10` (most Phenom-Cloud tenants do) and add `{ source: 'pcsx', slug, displayName, apiBase, domain, applyUrlBase }` to `COMPANIES`. |
| `capgemini` | Single-tenant | `src/collectors/capgemini.js` | Capgemini's in-house Azure-hosted search API. Paginates all 6,550 global rows then filters to `country_code === 'en-us'` client-side (the server's country filter is ignored). |
| `wipro` | Single-tenant | `src/collectors/wipro.js` | SAP SuccessFactors-backed in-house endpoint at `careers.wipro.com/services/recruiting/v1/jobs` (POST). `location: "United States"` param narrows the catalog server-side. |
| `goldman_sachs` | Single-tenant | `src/collectors/goldman_sachs.js` | Anonymous GraphQL at `api-higher.gs.com/gateway/api/v1/graphql`. Pulls all ~1.4k global roles (server-side location filter schema is undocumented) and filters to US client-side via `locations[].country`. |
| *(scraper)* `deloitte` | Playwright | `scraper/src/targets/deloitte.js` | SSR DOM scrape of `apply.deloitte.com/en_US/careers/SearchJobs`. 10 rows/page via `?jobOffset=N`, capped at 30 pages. |
| *(scraper)* `phenom` | Playwright | `scraper/src/targets/phenom.js` | Generic Phenom People DOM scraper (Cisco + Cognizant). Infinite-scroll gives ~10 rows/tenant/run; deeper coverage gated behind tenant-specific "show more" buttons. |
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
| Visa | All known Visa careers entry URLs are 404 or DNS-dark (`corporate.visa.com/en/jobs*`, `usa.visa.com/careers*`, `careers.visa.com`, `jobs.visa.com`). No confirmed endpoint. |
| ~~Cisco~~ / ~~Cognizant~~ | Partially implemented via the `phenom` scraper target — see Sources table above. Coverage bounded at ~10 rows per tenant per run. |
| Goldman Sachs | Workday CxS returns 422 anonymously under `goldmansachs.wd1`/`wd5` for `External`, `GS_External_Careers`, `Professional`, `Campus`, and the `goldman`/`gs` tenant aliases (2026-04-24). |
| ~~Deloitte~~ | Implemented as the `deloitte` Playwright target (SSR DOM scrape) — see Sources table above. |
| General Electric / Vernova / Aerospace | `ge.wd1/wd5` returns 422; `jobs.gevernova.com` and `jobs.geaerospace.com` are both DNS-unresolvable. Unknown backends. (GE HealthCare is implemented — see `gehealthcare` Workday entry.) |
| ~~Wipro~~ | Implemented via the `wipro` collector (SAP SuccessFactors endpoint at `careers.wipro.com/services/recruiting/v1/jobs`) — see Sources table above. |
| HCL America | `careers.hcltech.com` loads but exposes no public job-search JSON — just an OneTrust cookie banner + internal telemetry beacon. No job links on the homepage. `www.hcltech.com/careers` returns HTTP/2 protocol error; `careers.hcltech.com`, `jobs.hcltech.com`, `apply.hcltech.com` are all DNS-dark (2026-04-24). |
| Shopify | Career site is an in-house Shopify Next.js SPA (`shopify.com/careers/search`) — no public JSON API. Greenhouse/Lever/Ashby all 404; `shopify.wd1.myworkdayjobs.com/shopify_careers` returns 422 (2026-04-24). |
| Atlassian | Lever board `atlassian` exists but returns 0 postings (migrated off). Greenhouse 404 under every tried slug; Ashby 404; SmartRecruiters `atlassian`/`Atlassian` returns 0. Current destination ATS appears non-public (2026-04-24). |
| Tesla direct | `tesla.com/cua-api/apps/careers/state` returns 403 (Cloudflare UA-filtered). We get Tesla via ghlistings instead (~68 rows). |
| startup.jobs | Cloudflare "Just a moment..." challenge on every endpoint (homepage, `/feed` RSS, `/api/v1/*`). Same bucket as LinkedIn/Indeed. Won't ship. |
| wellfound.com (AngelList) | robots.txt explicitly disallows `/_jobs/`, `*?jobId=*`, `*?jobSlug=*`, `/job_listings/*`, `/job_profiles/embed`, `/jobs/applications`. Legal/ToS red line. Won't ship. |
| thehub.io | Nordic/Danish focus; effectively zero US rows after `FILTER_US=true`. Not worth implementation effort. |
| theantijobboard.com | Not actually a jobs site — landing page for an email newsletter. No scrapeable listings. |
| builtin.com | robots permissive, sitemap published, but content Cloudflare-gated and US-tech startup coverage overlaps heavily with Greenhouse/Lever/Ashby via the YC + topstartups probes. Duplicate yield not worth the effort. |
| topstartups.io (as a job collector) | Not a job board — company directory whose "View Jobs" links jump to per-company Notion/career pages. Instead used as a **company-discovery source** via `scripts/probe-topstartups.js`. |

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

## UI notes (`web/`)

React + Vite SPA. TanStack Query owns all server state (rows, pagination
total, filter-scoped results); local component state owns the filter
form. The whole thing builds to static files at `web/dist/` served by
Express — no separate dev process needed in production. In dev,
`npm run dev` inside `web/` runs Vite at :5173 with `/jobs`, `/stats`,
`/health`, `/admin` proxied to the Express port.

What to know:

- **Auto-refresh doesn't flicker.** `useJobs()` sets `refetchInterval: 60_000`
  with `placeholderData: keepPreviousData`. The query silently polls; the
  UI keeps rendering the previous rows until the new ones arrive. No
  "Loading…" flash on filter change or pagination.
- **"N new jobs · click to add" toast.** Background refetches compare the
  new `pagination.total` against `lastSeenTotal` (captured at last explicit
  user interaction). If the total grew, the toast appears. Clicking it
  sets `lastSeenTotal := total` and invalidates the query so the table
  repopulates. Preserves scroll + reading position.
- **Window-focus refetch.** `refetchOnWindowFocus: true` in the default
  `QueryClient` config — returning to the tab triggers an immediate
  revalidation.
- **Retries.** Default 2 retries with capped exponential backoff (~1s,
  2s, 4s). Covers the 503 window when the server clears its cache during
  a collect run.
- **Pagination clamp.** `App.jsx` watches `totalPages` and dispatches
  `clamp` if a filter change drops the current page below the new max —
  so narrowing filters never strands you on an empty page.
- **Single QueryClient.** Defined in `main.jsx`. `staleTime: 15_000`
  keeps us in sync with the server-side 30s cache; any longer would risk
  showing post-cron-tick-stale data.

### Styling
`web/src/styles.css` is a handwritten CSS file — no Tailwind, no CSS-in-JS.
All color/spacing/radius tokens at the top as custom properties; swap
them to re-theme. Palette is light Figma-ish: off-white bg, pure white
cards, violet accent, soft pastel pills for entry/mid/YES/NO/UNKNOWN.
Inter via Google Fonts (loaded in `web/index.html`).

### Running the dev server separately
```bash
# Terminal A — backend
PORT=4000 npm start

# Terminal B — Vite HMR with proxy to :4000
cd web && npm run dev
# open http://localhost:5173
```
For normal use, just `./run-all.sh` — it runs `npm run build` in `web/`
when `web/src/*` is newer than `web/dist/index.html`, and Express serves
the built bundle on the same port as the API.

### Migration note: Vercel
When moving to the hosted architecture in HOSTING.md, the React code here
drops into a Next.js app as-is (components are framework-agnostic,
TanStack Query runs identically on Next.js). The rewrite there is mostly
wiring, not re-architecting.

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
Run the probe, then the verifier, then review the verified output before
pasting into `src/config.js::COMPANIES`:
```bash
node scripts/probe-yc-ats.js > scripts/yc-ats-discovered.txt   # ~3 min
node scripts/verify-yc-ats.js                                  # reads the .txt, writes verified.txt + rejected.txt
# Review scripts/yc-ats-verified.txt, copy desired rows into src/config.js
# When done, the .txt artifacts can be deleted — they're reproducible.
```
The probe loads the YC US-hiring company list and probes each against the
three ATS public APIs with slug variants (YC slug, name-dashed, name-flat,
website domain stem). The **verifier** then filters out slug collisions by
(a) exact-matching the Greenhouse board name against the company name via
`/boards/{slug}` and (b) requiring Lever/Ashby slugs to be derivable from
the YC name or website (provenance check). Real collisions it has caught:
`greenhouse:beam` → "Bridge to Enter Advanced Mathematics" nonprofit,
`greenhouse:14` → a veterinary hospital, `greenhouse:apollo` → "Apollo
Education Systems". **Duplicates** from the upstream YC feed are deduped on
`(source, slug)`.

### Discover more non-YC curated startups on Greenhouse/Lever/Ashby
Run the topstartups probe:
```bash
node scripts/probe-topstartups.js                 # full run, ~5 min
node scripts/probe-topstartups.js --max-pages=10  # quick sample
```
Paginates topstartups.io, extracts US-HQ companies, probes the three ATSes,
and verifies with the same rules as the YC flow (Greenhouse name-match +
Lever/Ashby provenance). Writes `scripts/topstartups-ats-discovered.txt`
and `scripts/topstartups-ats-rejected.txt`. Review the discovered file
before pasting into `src/config.js::COMPANIES`; delete the artifacts once
merged.

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
- `RETENTION_DAYS` — drop jobs older than N days (default: `30`; see "Retention" below)
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
- **Dedupe by company|title|location, not by external_id — with `apply_url` as a secondary key.** Same role from multiple sources (e.g. Nvidia appears in both Workday and ghlistings) merges into one row. The canonical key collapses cosmetic drift (strips `Inc/LLC/Corp`, parenthetical title modifiers like `(Remote)`, and trailing country codes from location). When two sources publish the same apply URL under slightly different metadata, `upsertJob` does a secondary lookup on `apply_url` and merges them.
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
- **Probe-tool output is a snapshot, not a feed.** The discovered/verified txt files reflect the state at the moment they were run. Re-run the probe monthly or whenever the YC feed refreshes.

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

1. **Re-collect to pick up the merges.** `COMPANIES` jumped from ~47 to 682 on 2026-04-24; current DB stats still reflect the pre-merge state. Run `rm -rf data/ && npm run init-db && npm run collect` (or just `npm run collect` on the existing DB) to bring it current.
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
- Don't re-investigate startup.jobs, wellfound.com, builtin.com, thehub.io, or theantijobboard.com — see "intentionally not implemented" table for each site's specific blocker.
- Don't auto-paste raw `scripts/probe-yc-ats.js` output into `src/config.js` without running `verify-yc-ats.js` first. The raw probe uses loose slug variants (including bare domain stems) that false-match unrelated companies.
- Don't auto-paste `probe-topstartups.js` output either. Verification is already built into that probe, but review before merging — collisions the probe can't distinguish (e.g. two unrelated companies with the same name) still slip through.
- Don't re-sync main and scraper cron (`0 */2 *` and `30 */6 *`). The 30-min offset is intentional — prevents overlapping DB writes.
