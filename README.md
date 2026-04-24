# US SWE / MLE / DS Job Aggregator

> **Run everything with a single command:**
> ```bash
> ./run-all.sh
> ```
>
> Starts the main API + scheduler + Playwright scraper microservice, auto-
> picks a free port, opens the browser, streams logs with `[main]` / `[scr ]`
> prefixes, and cleans up both services on Ctrl+C.
>
> **For a full agent-readable state dump** (architecture, sources, decisions,
> extension recipes, known issues, red lines), see **[HANDOFF.md](HANDOFF.md)**.
>
> **Architecture at a glance:** main service in this repo handles all the
> stable free APIs. A separate opt-in **[scraper microservice](scraper/)**
> uses Playwright to scrape the ones that need a real browser. The two are
> isolated — if the scraper breaks, the main job board keeps running.


A small production-quality MVP that aggregates **US entry-level software &
ML/AI/data** job postings from public ATS APIs, stores them in SQLite,
classifies the role type and visa sponsorship with rules, and serves them from
a tiny Node/Express API plus a zero-dependency HTML/JS UI.

Sources:
**Greenhouse, Lever, Ashby, Workday** (Adobe / Nvidia / PayPal / Salesforce /
Intel), **Amazon** (`amazon.jobs`), and the community-maintained
**[vanshb03/New-Grad-2027](https://github.com/vanshb03/New-Grad-2027)** list
(which gives us Google / Apple / Meta / Tesla / TikTok / ByteDance coverage we
can't get from their own career sites). Each source is a self-contained module
— adding a new source is one file + one line in a registry.

Roles tracked: SWE / SDE, MLE, AI / Research, Data Scientist, Data Engineer,
SRE / Platform, Security, Mobile.

**Full-time only** — internships and co-ops are filtered out by default.

```
Job/
├── package.json
├── README.md
├── web/                 # React UI (Vite + TanStack Query); built to web/dist/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── api.js
│       ├── styles.css
│       ├── hooks/useJobs.js
│       └── components/  # TopBar, Filters, JobsTable, Pager, NewJobsToast
└── src/
    ├── index.js         # Entry: boots API + scheduler
    ├── config.js        # Companies list & runtime config
    ├── logger.js
    ├── scheduler.js     # node-cron, runs collect every 6h
    ├── db/index.js      # SQLite schema + queries
    ├── collectors/      # One module per source
    │   ├── greenhouse.js
    │   ├── lever.js
    │   ├── ashby.js
    │   ├── workday.js    # CxS JSON endpoints (Adobe, Nvidia, PayPal, …)
    │   ├── amazon.js     # amazon.jobs search JSON
    │   ├── microsoft.js  # (disabled by default — Microsoft TLS bug)
    │   └── index.js      # Registry — add sources here
    ├── services/
    │   ├── classifier.js   # Sponsorship rules
    │   ├── normalize.js    # Common schema + US/software filters
    │   ├── dedupe.js
    │   └── collect.js      # Orchestrator
    ├── api/
    │   ├── server.js       # Express app
    │   └── cache.js        # 30s TTL cache for /jobs
    └── scripts/
        ├── collect-once.js
        └── init-db.js
```

## Setup

Requires Node ≥ 18.17 (18+ has native `fetch`). Tested on Node 25.

```bash
cd Job
npm install
npm run init-db
```

## Run everything (API + scheduler + UI)

```bash
npm start
# → http://localhost:3000
```

On startup the scheduler fires a collection once, then every 2 hours
(`0 */2 * * *`). Set `RUN_ON_START=false` to skip the initial run.

### Environment variables

| var | default | purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/jobs.db` | SQLite file |
| `COLLECT_CRON` | `0 */6 * * *` | Cron for scheduled collection |
| `RUN_ON_START` | `true` | Collect once at boot |
| `COLLECT_TOKEN` | _(unset)_ | If set, required as `x-collect-token` header on `POST /admin/collect` |
| `FILTER_US` | `true` | Drop non-US locations during collection |
| `FILTER_SOFTWARE` | `true` | Drop titles that don't classify as a tech role |
| `ENTRY_LEVEL_MODE` | `permissive` | `off`, `permissive` (drop senior/staff/principal/manager/II+), or `strict` (require an explicit entry-level signal) |
| `DEBUG` | _(unset)_ | Enables `DEBUG` log lines |

### Other scripts

```bash
npm run collect    # One-shot collection run, no API
npm run api        # API only, no scheduler (good for frontend dev)
npm run init-db    # Create SQLite schema
```

## Data sources

All free, public, no auth, no scraping of LinkedIn/Indeed:

| Source        | Endpoint                                                                                    | Method |
|---------------|---------------------------------------------------------------------------------------------|--------|
| Greenhouse    | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`                       | GET    |
| Lever         | `https://api.lever.co/v0/postings/{slug}?mode=json`                                          | GET    |
| Ashby         | `https://api.ashbyhq.com/posting-api/job-board/{slug}`                                       | GET    |
| Workday       | `https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`                     | POST   |
| Amazon        | `https://www.amazon.jobs/en/search.json?base_query={q}&loc_query=United+States`              | GET    |
| Uber          | `https://www.uber.com/api/loadSearchJobsResults?localeCode=en-us`                            | POST   |
| Netflix       | `https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=…&num=…&query=…`| GET    |
| ghlistings    | Configurable JSON URL per entry (see below)                                                  | GET    |

The **ghlistings** source is a generic collector for community-maintained
GitHub new-grad lists. It ships wired to two repos:

* `vanshb03/New-Grad-2027`
* `SimplifyJobs/New-Grad-Positions`

Both repos share a schema and already label each row's sponsorship
(`Offers Sponsorship` / `Does Not Offer Sponsorship` /
`U.S. Citizenship is Required` / `Other`) — those labels take precedence over
our rule-based classifier. Every row is flagged entry-level by construction.
Rows that appear in both repos dedupe automatically via the
`company | title | location` key.

### Adding a new source

1. Create `src/collectors/<source>.js` exporting
   `{ source, fetchCompany(company) }` where the return is an array of raw jobs
   with fields `source`, `external_id`, `company_name`, `job_title`,
   `location`, `apply_url`, `description` (HTML OK), `date_posted`.
2. Register it in `src/collectors/index.js`.
3. Add company entries to `COMPANIES` in `src/config.js`. For Workday, include
   `tenant`, `wd`, `site`.

### Shipped companies (edit `src/config.js` to add/remove)

| Source | Companies |
|---|---|
| Greenhouse | Stripe, Airbnb, Robinhood, Coinbase, Figma, Discord, Instacart, Dropbox, Anthropic, Databricks, Cloudflare, Reddit, Pinterest, Lyft, Datadog, Twilio, Asana, Brex, Mercury, GitLab, Block (Square), Affirm, Chime, Scale AI |
| Lever | Palantir, Spotify |
| Ashby | PostHog, Ramp, Linear, Perplexity, ElevenLabs, Notion, **OpenAI**, Cursor |
| Workday | **Nvidia, Adobe, PayPal, Salesforce, Intel** |
| Amazon | amazon.jobs (queries: SWE, SDE, MLE, Applied Scientist, Data Scientist, Data Engineer) |
| ghlistings | 100+ companies across both repos, including **Google, Apple, Meta, Microsoft, Tesla, TikTok, ByteDance, SpaceX, Nvidia, Adobe, Palantir, Roblox, Qualcomm, RTX, Lockheed, Northrop Grumman, Goldman Sachs, JP Morgan, Morgan Stanley, SIG, Citadel, Boeing, Intel, AMD** |

Bad slugs just log a warning and skip — safe to over-include.

### Direct-API access matrix (honest state as of 2026-04)

I tested every company below against their own public endpoints. The short
version: Amazon, Uber, and the listed Workday tenants are the direct wins;
the rest either have no JSON API, require auth, or serve bad TLS certs.

**H-1B Top-10 sponsors (USCIS FY2026 Employer Data Hub):**

| Rank | Company | Own API status | Our coverage |
|---|---|---|---|
| 1 | **Amazon** | `amazon.jobs/en/search.json` — works, no auth | direct ✅ |
| 2 | **Tata Consultancy Services** | Custom ATS (TCS iBegin) not publicly resolvable; DNS on `ibegin.tcs.com` doesn't respond | none ❌ |
| 3 | **Microsoft** | `gcsservices.careers.microsoft.com` 404s (retired); `jobs.careers.microsoft.com` 301s to `apply.careers.microsoft.com` which now exposes a usable `/api/pcsx/search` surface | direct + ghlistings ✅ |
| 4 | **Infosys** | Career site on Oracle Taleo — no free public JSON search | none ❌ |
| 5 | **Google** | `careers.google.com/api/v3/search/` returns 404; no usable public JSON exists | ghlistings + Playwright DOM scrape ✅ |
| 6 | **Apple** | `jobs.apple.com/api/role/search` returns 404; newer `api/v1/*` paths return 401 (cookie-gated) | ghlistings only (15) |
| 7 | **Cognizant** | Workday tenant `cognizant.wd*` rejects anonymous CxS calls with 422/401 on every site+facet combination tried | none ❌ |
| 8 | **Meta** | `metacareers.com` is GraphQL with signed `doc_id` tokens — hostile to direct API collectors | ghlistings + Playwright DOM scrape ✅ |
| 9 | **Tesla** | `www.tesla.com/cua-api/apps/careers/state` returns 403 (Cloudflare-protected, UA-filtered) | ghlistings (68) |
| 10 | **Walmart** | `walmart.wd5.myworkdayjobs.com/wday/cxs/walmart/WalmartExternal/jobs` — works, no auth | direct ✅ |
| — | **Netflix** | `explore.jobs.netflix.net/api/apply/v2/jobs` (Eightfold AI) — works, no auth | direct ✅ |

**Other direct wins (not in top-10):** Nvidia / Adobe / PayPal / Salesforce /
Intel (public Workday CxS endpoints).

**Other known blocks:** Netflix (migrated off Lever, no open JSON), Cisco
(Workday CxS returns 422 anonymously).

Why the gaps are real and not me giving up:

1. **Google / Apple / Meta** actively prevent clean direct-API aggregation via
   TLS gating, signed tokens, and deprecated endpoints. Google and Meta are
   now handled by the opt-in Playwright scraper; Apple remains blocked.
2. **Microsoft** is mid-migration — their public JSON surface genuinely isn't
   there right now. The TLS-bypass machinery in `src/collectors/http.js` is
   already in place so when they restore an endpoint, I only need to update
   one URL.
3. **Cognizant / Cisco** have Workday tenants but are configured to reject
   anonymous API access. That's a real block by the companies, not a bug on
   our side.
4. **TCS / Infosys** — large Indian IT services shops running closed ATSes
   (TCS iBegin, Oracle Taleo) with no public JSON search. These companies
   sponsor a lot of H-1B but publish very few listings publicly; roles are
   typically filled via on-campus + in-person recruiting, not web job boards.
   This is a structural gap, not a scraping problem.

If you want fuller coverage for the blocked companies, the realistic options
are: (a) LinkedIn (paid, brittle, ToS-gray), (b) a paid aggregator like
Adzuna, or (c) checking those careers pages manually for the few roles you
care about.

### What I investigated for Google / Apple / Meta / Microsoft and what shipped

I probed each site's actual frontend traffic to find the backend APIs their
career pages call. Summary of what I found:

* **Netflix** (`explore.jobs.netflix.net`) → Eightfold-powered, public JSON
  at `/api/apply/v2/jobs`. **Shipped as `netflix.js`.**
* **Microsoft** (`apply.careers.microsoft.com`) → Eightfold-powered, same
  endpoint shape as Netflix. Returns `403 {"message": "Not authorized for
  PCSX"}` without a JS-generated auth token. The token is bootstrapped at
  page load by their frontend bundle.
* **Apple** (`jobs.apple.com`) → All `/api/role/search` and `/api/v1/*` paths
  return 301/401. Page HTML has no inline job data — everything is fetched
  client-side with a cookie-gated auth header.
* **Meta** (`metacareers.com/jobsearch`) → Powered by their internal Relay
  GraphQL. The `/jobsearch` HTML loads (441KB, LSD token extractable), but
  the `doc_id` needed to call `/graphql` is only present in lazily-loaded
  JS bundles that require a JS engine to execute. No `doc_id` in the raw
  HTML. The `/graphql` endpoint also requires `fb_dtsg` CSRF tokens.
* **Google** (`careers.google.com`) → `/api/v3/search` retired, returns 404.
  The modern `/about/careers/applications/jobs/results/` page is 1.25MB of
  server-rendered HTML with zero embedded job data — it's all fetched at
  runtime from an undocumented endpoint inside their JS bundles.

**The honest summary:** Google/Apple/Meta/Microsoft deliberately gate their
career APIs with JS-generated tokens, rotating GraphQL doc_ids, and cookie-
gated auth. Microsoft now has a direct collector; Google and Meta now have
an opt-in Playwright DOM scraper; Apple is still blocked.

### Playwright browser scraping (shipped as opt-in)

For the blocked direct-API sites, the fallback is a real browser
(Playwright), which reads the rendered DOM and public detail pages instead of
depending on the gated RPC/GraphQL surfaces. This works, but it has hard
costs:

* ~300 MB of Chromium + Playwright dependencies
* 20-60 seconds per page (vs ms for our current collectors)
* Anti-bot defenses (reCAPTCHA on Microsoft's page, IP rate limiting) need
  paid residential-proxy rotation (~$50-100/month)
* Breaks on every frontend deploy — Google and Meta ship UI changes weekly
* Explicitly prohibited by each company's ToS; legal gray area under CFAA

This is shipped as the separate `scraper/` microservice and can be disabled
with `RUN_SCRAPER=false` if you want the main app only.

Why the gap is real and not me giving up:

1. **Google/Apple/Meta** actively prevent programmatic aggregation of their
   listings via TLS gating, signed tokens, or removing public endpoints.
   Working around those either needs paid scraping infra with residential
   proxies (expensive, brittle, often violates ToS) or reverse-engineered
   auth tokens (breaks on every redeploy).
2. **Microsoft** could probably be reached with
   `NODE_TLS_REJECT_UNAUTHORIZED=0`, but disabling TLS verification on a
   production-style app is a real security regression I won't ship by default.
3. **Cisco** is a Workday tenant configured to reject unauthenticated access —
   a real block by Cisco, not a bug on our side.

If you want fuller coverage for the blocked companies, the realistic options
are: (a) LinkedIn (paid, brittle, ToS-gray), (b) a paid aggregator like
Adzuna / USAJobs-style scraping services, or (c) checking those careers pages
manually for the few roles you care about.

## Normalization, role classification & filters

Each raw job is normalized in `src/services/normalize.js`:

1. **HTML stripped** from descriptions.
2. **Location filter** — dropped unless it looks US (state name/code, known
   US city, or `remote` without EMEA/APAC/UK/Canada/India hints).
3. **Role classifier** — assigns one of:
   `SWE`, `MLE`, `AI`, `DS`, `DATA_ENG`, `SRE`, `SECURITY`, `MOBILE`, `OTHER`.
   `OTHER` is dropped when `FILTER_SOFTWARE=true` (default).
4. **Internship reject** — titles containing `intern`, `internship`, `co-op`,
   or `Summer 20XX` are always rejected (full-time only).
5. **Level filter** (`ENTRY_LEVEL_MODE`):
   - `off` — keep everything (still drops interns)
   - `permissive` (default) — drop titles containing
     `senior / sr / staff / principal / lead / director / manager / head of /
     VP / architect / III / IV / V / VI`. **`II` is allowed through** — at
     most companies "Software Engineer II" means 1-3 YOE, which is the
     mid-level bucket the user is targeting.
   - `strict` — additionally require an explicit entry signal
     (`new grad`, `university`, `associate`, `junior`, `jr`, `Engineer I`,
     `Engineer 1`, etc.)
6. **`is_entry_level`** flag is set to 1 when the title explicitly looks
   entry-level (or when the source pre-labels it, like ghlistings) — UI shows
   an "entry" pill.
7. **`is_mid_level`** flag is set to 1 when the title contains an explicit
   mid-level signal (`Engineer II`, `Engineer 2`, `Mid-level`, `1-2 years`, …)
   and isn't already entry-level — UI shows a "mid · 1-2y" pill.
7. **Sponsorship override** — sources that pre-label sponsorship (currently
   newgrad2027) supply a `sponsorship_override` that wins over the
   rule-based classifier.
8. **Dedup key** = `lower(company) | lower(title) | lower(location)`, enforced
   both in-batch and by a UNIQUE index in SQLite — re-runs bump
   `last_seen_at` instead of inserting duplicates. This also merges the same
   role coming from two sources (e.g. Nvidia appears in both Workday and
   newgrad2027).

## Sponsorship classification

Rule-based, in `src/services/classifier.js`. Precedence:

1. **NO** if the text matches any of:
   `must be (legally )authorized to work`, `no sponsorship`,
   `unable to sponsor`, `cannot sponsor`, `do(es) not (offer|provide) sponsorship`, `not (offering|providing) sponsorship`
2. **YES** if the text matches any of:
   `visa sponsorship`, `h1b/h-1b sponsorship`, `will sponsor(ship)`, `sponsor(a) visa`
3. **UNKNOWN** otherwise.

Run against `job_title + description` (HTML-stripped).

## Scheduler

* `node-cron` registered with `COLLECT_CRON` (`0 */2 * * *` = every 2 hours,
  at minute 0 — so 00:00, 02:00, 04:00, …). Override via the env var, e.g.
  `COLLECT_CRON='*/30 * * * *'` for every 30 minutes.
* Single-flight: if a run is still in progress when the next tick fires,
  the new tick is skipped and logged. Workday description enrichment means a
  full run takes ~45–70 seconds; this guards against overlap on fast cadences.
* Each run inserts a row in `collection_runs` with totals and any errors.
* On failure, the error is logged and captured in `collection_runs.errors`
  — collection keeps going for the remaining companies.

## API

All endpoints return JSON.

### `GET /health`
```json
{ "ok": true, "uptime": 12.3 }
```

### `GET /stats`
```json
{
  "total": 376,
  "bySponsor": [
    { "sponsorship": "UNKNOWN", "c": 375 },
    { "sponsorship": "YES", "c": 1 }
  ],
  "lastRun": {
    "id": 1,
    "started_at": "2026-04-23 18:55:26",
    "finished_at": "2026-04-23 18:55:34",
    "companies_ok": 13,
    "companies_fail": 0,
    "jobs_inserted": 376,
    "jobs_updated": 0,
    "errors": "[]"
  }
}
```

### `GET /jobs`

Query params (all optional):

* `search` — case-insensitive substring over title + company
* `sponsorship` — `YES` | `NO` | `UNKNOWN`
* `company` — exact match (case-insensitive)
* `role` — `SWE` | `MLE` | `AI` | `DS` | `DATA_ENG` | `SRE` | `SECURITY` | `MOBILE`
* `level` — `entry` (flagged entry-level), `mid` (flagged 1-2 YOE), `early` (either) — `entry=true` is still accepted as a legacy alias
* `page` — 1-indexed, default `1`
* `limit` — default `50`, max `200`

Response:

```json
{
  "data": [
    {
      "id": 42,
      "source": "greenhouse",
      "company_name": "Stripe",
      "job_title": "Backend Engineer, Payments and Risk",
      "location": "New York",
      "apply_url": "https://stripe.com/jobs/listing/...",
      "date_posted": "2026-04-18T12:04:05Z",
      "sponsorship": "UNKNOWN",
      "first_seen_at": "2026-04-23 18:55:33",
      "last_seen_at": "2026-04-23 18:55:33"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 376, "totalPages": 8 },
  "filters": { "search": "", "sponsorship": "", "company": "" }
}
```

Response headers include `x-cache: HIT|MISS` from the 30s TTL cache.

### `GET /jobs/:id`
Full row including `description` (HTML-stripped plain text).

### `POST /admin/collect`
Force a collection run. If `COLLECT_TOKEN` is set, send it as
`x-collect-token`. Returns the run summary and clears the cache.

### Example `curl`

```bash
# Entry + mid (1-2 YOE) ML roles with visa sponsorship, paginated
curl 'http://localhost:3000/jobs?role=MLE&level=early&sponsorship=YES&page=1&limit=25'

# Mid-level SDE II roles at Amazon
curl 'http://localhost:3000/jobs?company=Amazon&level=mid&role=SWE'

# Anything at Google / Apple / Meta
for c in Google Apple Meta; do curl "http://localhost:3000/jobs?company=$c"; done

# Trigger a collection run manually
curl -X POST http://localhost:3000/admin/collect
```

## Frontend

Plain HTML + one JS file. Served from Express at `/`. Supports:

* Title/company search (debounced)
* Role-type dropdown (SWE / MLE / AI / DS / Data Eng / DevOps-SRE / Security / Mobile)
* Sponsorship filter (YES / NO / UNKNOWN)
* Level dropdown: Any level (default) / Entry-only / Mid only (1-2 YOE) / Entry or mid
* Pagination
* `Apply` button opens the source posting in a new tab

Rows carry small pills — the role-type bucket, and an `entry` or `mid · 1-2y`
badge on titles the classifier flagged.

## Database schema

```sql
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key     TEXT    NOT NULL UNIQUE,      -- company|title|location (slugified)
  source         TEXT    NOT NULL,             -- greenhouse|lever|ashby|workday|amazon
  external_id    TEXT,                         -- id from the source
  company_name   TEXT    NOT NULL,
  job_title      TEXT    NOT NULL,
  location       TEXT,
  apply_url      TEXT    NOT NULL,
  description    TEXT,                         -- HTML-stripped
  date_posted    TEXT,                         -- ISO8601 if available
  sponsorship    TEXT    NOT NULL DEFAULT 'UNKNOWN',
  role_type      TEXT    NOT NULL DEFAULT 'OTHER',
  is_entry_level INTEGER NOT NULL DEFAULT 0,
  is_mid_level   INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL
);

CREATE TABLE collection_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  companies_ok    INTEGER NOT NULL,
  companies_fail  INTEGER NOT NULL,
  jobs_inserted   INTEGER NOT NULL,
  jobs_updated    INTEGER NOT NULL,
  errors          TEXT                         -- JSON array
);
```

## Constraints honored

* Only free, public endpoints (no auth, no LinkedIn/Indeed scraping).
* Collectors are isolated modules with a single interface → easy to extend.
* Logging, retries (2x with backoff), request timeouts (20s), and graceful
  per-company failure handling.
* Idempotent upsert via UNIQUE key — re-running is safe.

## Bonus implemented

* **Caching** — 30s TTL cache on `/jobs` with `x-cache` header; cleared after each collection run.
* **Pagination** — `page` + `limit` with `totalPages`.
* **Logging** — Structured, level-prefixed lines with timestamps.
* **Concurrency control** — Up to 5 companies fetched in parallel.
