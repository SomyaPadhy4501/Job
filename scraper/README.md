# Playwright Scraper Microservice

Independent service that scrapes the "hostile" career sites — the ones with
no public JSON API — using a real Chromium browser and network-response
interception. Pushes jobs to the main API via `POST /admin/ingest`.

## Why this is a separate service

Playwright + Chromium is ~300 MB of deps that break in ways the stable
collectors don't (UI redeploys, new anti-bot challenges, rate limits). If
this service crashes at 3am, the main job board keeps serving everything
else it already has.

```
┌───────────────────────┐  POST /admin/ingest   ┌───────────────────────┐
│  scraper (this dir)   │ ───────────────────▶  │  main API (parent)    │
│  Playwright + cron    │  {source, jobs: [..]} │  normalize + upsert   │
└───────────────────────┘                       └───────────────────────┘
                                                   ▲
                                                   │ (also talks to)
                                                   │
                                               SQLite + UI
```

## Setup

The top-level `./run-all.sh` handles this automatically on first run
(installs npm deps + downloads Chromium). If you want to do it manually:

```bash
cd scraper
npm install                       # ~50 MB for playwright + node-cron
npx playwright install chromium   # ~250 MB (one-time)
```

## Usage

Normal operation is via the parent project's `./run-all.sh` — that script
starts the scraper alongside the main API with a shared lifecycle. Run it
standalone only for debugging:

| Command | What it does |
|---|---|
| `node src/index.js` | Run with a cron schedule (every 6 h by default). Expects `INGEST_URL` to point at a running main API |
| `npm run scrape` | One-shot: scrape all configured targets once, ingest, exit |
| `npm run scrape:one -- <slug>` | Scrape only one target (debug). `<slug>` ∈ `google`, `meta`, `apple` |
| `node src/debug-urls.js <url>` | Navigate to `<url>` and print every non-static response URL with a "★ JOBS" flag if it looks like a jobs payload. Use this when a target's endpoint changes |

## Configuration (env vars)

| var | default | purpose |
|---|---|---|
| `INGEST_URL` | `http://localhost:4000/admin/ingest` | Where to POST scraped jobs |
| `COLLECT_TOKEN` | _(unset)_ | If main API requires `x-collect-token`, match it here |
| `SCRAPER_CRON` | `30 */6 * * *` | Cadence (every 6 h at :30) |
| `SCRAPER_TARGETS` | `apple,meta,google` | Comma-separated targets to run |
| `RUN_ON_START` | `true` | Fire one scrape immediately at boot |
| `HEADLESS` | `true` | Set `false` to see Chromium in action (debug) |
| `NAV_TIMEOUT_MS` | `45000` | Per-navigation timeout |
| `TARGET_TIMEOUT_MS` | `120000` | Overall per-target budget |
| `MAX_PAGES` | `5` | Max scroll iterations per target |

## Target-by-target honest status (as of 2026-04)

All numbers are from our last live run.

| Target | Method | Rows captured | Notes |
|---|---|---|---|
| **Microsoft** | *no longer in this service* | — | Promoted to a direct `/api/pcsx/search` collector in the main app — no browser needed. See `../src/collectors/microsoft.js`. |
| **Meta** | DOM scraping on `/jobsearch` plus detail pages at `/profile/job_details/*` | **26 raw rows** | Scrapes the rendered search results instead of replaying GraphQL. Coverage comes from multiple search/team views, then per-job detail extraction. Still does not walk true pagination. |
| **Apple** | Response interception on `jobs.apple.com/api/*` | **0** | Apple's SPA is cookie-gated even for the initial page. The API responses that fire during our Playwright session don't contain job list data — they're auth/config calls. Getting jobs would require maintaining a logged-in session or reverse-engineering their new signed-request flow. |
| **Google** | DOM scraping on Careers search + job detail pages | **21 raw rows** | Avoids the old `/_/careersfrontend/*` RPC entirely. The target fans out across several Google Careers role queries, discovers detail URLs from the rendered results page, and enriches them from public detail pages. |

In other words: **this service genuinely tries and honestly reports.** The
only big-tech "wins" (Microsoft, Netflix, Uber, Amazon) are already handled
in the main service because their APIs don't actually need a browser. The
remaining three (Google, Meta, Apple) are where this scraper lives. Google
and Meta now work via DOM scraping; Apple is still blocked.

## How to extend when a target's endpoint changes

1. Run the debug tool against the target URL:
   ```bash
   node src/debug-urls.js 'https://jobs.apple.com/en-us/search?search=Software+Engineer'
   ```
2. Look for lines marked with `★ JOBS` — those are the response URLs that
   contain job-shaped data.
3. Copy the URL and open `src/targets/<slug>.js`. Update:
   * `responseMatcher` to match that URL.
   * `extract` to map the real response shape to our common `rawJob` schema:
     ```
     { external_id, company_name, job_title, location, apply_url,
       description, date_posted }
     ```
4. Re-run `npm run scrape:one -- <slug>` to confirm.

## When to turn this off

Run the scraper only if you want the marginal Google/Meta/Apple coverage.
The 97%+ of jobs from every other source flow through the main service and
don't benefit from this running. If Playwright starts misbehaving, just
stop it — nothing else depends on it.

```bash
# stop cleanly
pkill -f 'scraper/src/index.js'
```

## Known fragility (be honest, you have been warned)

* Meta, Google, Apple push frontend UI changes constantly — the DOM
  selectors and API endpoints shift every few weeks.
* reCAPTCHA v3 on Microsoft's (old) page and Cloudflare challenges on some
  sites can trigger if you scrape too fast.
* Headless detection: these companies invest real engineering in
  fingerprinting automation. We don't ship stealth plugins by default. For
  heavier anti-bot evasion, add `playwright-extra` + `puppeteer-extra-plugin-stealth`
  — but that's a separate project.
* No residential proxy rotation. If you hit the same IP too often, expect
  throttling. For production use, pair with a proxy pool like Bright Data
  or Smartproxy.
