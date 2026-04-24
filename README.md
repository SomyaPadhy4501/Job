# US SWE / MLE / DS Job Aggregator

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
├── frontend/            # Static UI served by Express
│   ├── index.html
│   ├── styles.css
│   └── app.js
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
        ├── api-only.js
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
| newgrad2027   | `https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json` | GET    |

The **newgrad2027** source is a single curated JSON file. It already labels
each row's sponsorship (`Offers Sponsorship` / `Does Not Offer Sponsorship` /
`U.S. Citizenship is Required` / `Other`) — those labels take precedence over
our rule-based classifier. Every row is flagged entry-level by construction.

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
| newgrad2027 | 100+ companies including **Google, Apple, Meta, Tesla, TikTok, ByteDance, Nvidia, Adobe, Palantir, Roblox, Qualcomm, Twitch, Shopify, Citadel, IBM, Visa, AMD** |

Bad slugs just log a warning and skip — safe to over-include.

### Companies we *can't* reach via their own APIs

Google / Apple / Meta / Netflix don't expose a free JSON career API, and we
don't scrape their sites (ToS + brittleness). Instead we pull their postings
from the community-maintained **newgrad2027** source.

| Company | Why (direct) | Coverage via newgrad2027 |
|---|---|---|
| Google, Apple, Meta | No public JSON; JS-rendered careers pages | ✅ |
| Tesla, TikTok, ByteDance | Custom systems | ✅ |
| Microsoft | Public endpoint exists but serves an invalid TLS cert (`*.azureedge.net`). `microsoft.js` collector is shipped but disabled in default config | partial |
| Netflix | Moved off Lever; no open JSON | ❌ |
| DoorDash / Plaid / Snowflake / HashiCorp / Rippling | Use ATSes not covered by our collectors | partial |

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
5. **Entry-level filter** (`ENTRY_LEVEL_MODE`):
   - `off` — keep everything (still drops interns)
   - `permissive` (default) — drop titles containing
     `senior / sr / staff / principal / lead / director / manager / head of /
     VP / architect / II / III / IV / V`
   - `strict` — additionally require an explicit entry signal
     (`new grad`, `university`, `associate`, `junior`, `jr`, `Engineer I`,
     `Engineer 1`, etc.)
6. **`is_entry_level`** flag is set to 1 when the title explicitly looks
   entry-level (or when the source pre-labels it, like newgrad2027) — so the
   UI can surface them with an "entry" pill and `GET /jobs?entry=true` can
   target them directly.
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
* `entry` — `true` or `1` to return only rows flagged entry-level
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
# All entry-level ML roles with visa sponsorship, paginated
curl 'http://localhost:3000/jobs?role=MLE&entry=true&sponsorship=YES&page=1&limit=25'

# New-grad SDE roles at Amazon
curl 'http://localhost:3000/jobs?company=Amazon&entry=true&role=SWE'

# Anything mentioning "new grad" across sources
curl 'http://localhost:3000/jobs?search=new%20grad&limit=50'

# Trigger a collection run manually
curl -X POST http://localhost:3000/admin/collect
```

## Frontend

Plain HTML + one JS file. Served from Express at `/`. Supports:

* Title/company search (debounced)
* Role-type dropdown (SWE / MLE / AI / DS / Data Eng / SRE / Security / Mobile)
* Sponsorship filter (YES / NO / UNKNOWN)
* "Entry-level only" checkbox
* Pagination
* `Apply` button opens the source posting in a new tab

Rows carry two small pills — the role type bucket, and an `entry` badge on
titles the classifier flagged as explicitly entry-level.

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
