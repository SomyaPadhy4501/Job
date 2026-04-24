# Hosting — Job Aggregator

Read this **after** `HANDOFF.md`. That file describes the app as it runs locally
today (SQLite + node-cron + Express + Playwright microservice). This file
describes the target hosted deployment and the migration path to get there.

Written 2026-04-24 for a next agent to pick up. Somya has not yet decided on
all open questions — they are flagged at the bottom.

Related: `SPONSORSHIP_PLAN.md` describes a planned USCIS H-1B data-backed
sponsorship classifier. That plan is **explicitly hosting-neutral** (static
~3 MB JSON file bundled in the repo, no runtime API calls, no new secrets)
and does not affect anything in this document. If you execute that plan,
the only deployment impact is one extra file to bundle.

---

## Goal

Run the job aggregator 24/7 on free-tier hosting, with:
- Collectors firing every 2 h (HANDOFF.md §"User's priorities")
- Playwright scraper firing every 6 h
- Public URL that Somya can open from any device
- Zero fixed monthly cost

Not a goal: multi-user, auth, Airflow-grade orchestration, or anything not
already in `HANDOFF.md`.

---

## Why not Airflow

Airflow's value is orchestrating **dependent** tasks across DAGs with retries,
backfill, SLA alerts, and operator libraries for hundreds of systems. This app
has 15 collectors (+ 5 Playwright scraper targets) that:
- Run independently (no ordering, no shared state except the DB write)
- Finish in 6-7 minutes for the main collect, 10-12 minutes for the scraper
- Already fail-soft in `src/services/collect.js` (one collector failing doesn't
  break the run)

Adding Airflow means hosting its scheduler, metadata DB, and webserver — more
infra than the thing being orchestrated. For this shape of workload, a cron
trigger is the right tool. **GitHub Actions `schedule:` workflows are a
managed cron with free compute.** That's the "ETL scheduler" for this project.

Revisit Airflow only if the pipeline grows to:
- Cross-DAG dependencies (job A must finish before job B)
- Backfill requirements (rerun last 30 days of collection)
- More than ~50 sources where observability across them becomes hard

None of those are on the roadmap.

---

## Recommended architecture

```
┌─────────────────────────┐          ┌──────────────────────────┐
│ Vercel                  │          │ Neon (Postgres, free)    │
│ ─ Static frontend       │─────────▶│ ─ jobs, collection_runs  │
│ ─ /api/* read endpoints │  reads   │ ─ Single DB, 0.5 GB cap  │
│   (serverless funcs)    │          └──────────────────────────┘
└─────────────────────────┘                   ▲         ▲
          ▲                                   │ writes  │ writes
          │ HTTPS                             │         │
          │                                   │         │
    ┌─────┴─────┐              ┌──────────────┴──┐  ┌──┴───────────────┐
    │ Somya's   │              │ GitHub Actions  │  │ GitHub Actions   │
    │ browser   │              │ workflow:       │  │ workflow:        │
    └───────────┘              │  collect.yml    │  │  scrape.yml      │
                               │  cron: 0 */2 *  │  │  cron: 0 */6 *   │
                               │  runs: npm run  │  │  runs: Playwright│
                               │    collect      │  │    (Chromium)    │
                               └─────────────────┘  └──────────────────┘
```

**No VM.** Each component sits on a platform designed for its workload shape:

| Component          | Home              | Why                                              |
|--------------------|-------------------|--------------------------------------------------|
| Frontend (static)  | Vercel            | Zero-config for `web/dist/` (Vite build), free forever |
| Read API           | Vercel functions  | Stateless GETs, idle 99% of the time             |
| DB                 | Neon Postgres     | Managed, free 0.5 GB, scales to paid cleanly     |
| Collectors (2 h)   | GitHub Actions    | Cron + compute + secrets, free 2000 min/mo       |
| Scraper (6 h)      | GitHub Actions    | Chromium preinstalled, 7 GB RAM/run, free        |

**Free-tier math (updated 2026-04-24 after measuring real run times):**
- Collect cron: 12 runs/day × ~7 min = **~84 min/day = ~2,520 min/month**
- Scrape cron: 4 runs/day × ~12 min = ~48 min/day = ~1,440 min/month
- Total: **~3,960 min/month**

GitHub Actions free tier:
- Public repos: **unlimited** ← this budget fits.
- Private repos: **2,000 min/month** ← this budget does **not** fit. Either
  make the repo public, reduce collect frequency (e.g. every 3 h → 8 runs/day
  cuts collect to ~1,680 min/month + scraper = 3,120, still over), or pay
  GitHub Pro at $4/month for 3,000 min.

The original HOSTING.md estimate ("~2 min per collect") was wrong — the
collector fan-out now hits 700+ companies across 15 sources and runs 6-7
minutes end-to-end even with concurrency=4. This is the single biggest
gotcha for deploying: **verify the repo is public before relying on the free
tier math.**

**Cost estimate:** $0/month **only on a public repo**. DB size is no longer a
concern — the 30-day retention sweep (`src/db/index.js::pruneStaleJobs`)
holds the `jobs` table at ~1,600 rows (current state). The Neon 0.5 GB free
tier is ~200k rows of headroom; retention prevents us from ever approaching
it.

---

## Alternative architectures (considered, not recommended)

### Alt A: Single VM (Fly.io / Railway / Render)
Deploy the current code as-is onto a small always-on container. Keep SQLite
with a persistent volume.

- **Pro:** ~1 hour of work. No code changes except a `Dockerfile` and env vars.
- **Pro:** Scraper and collectors stay in the same process.
- **Con:** Free tiers are tight and shifting. Fly.io gives ~3 shared-cpu-1x
  VMs free but requires a credit card. Render's free web service sleeps after
  15 min idle (breaks cron). Railway dropped its free tier in 2023.
- **Con:** SQLite on a single volume means no backups unless you bolt them on.
- **Use this if:** You want to ship tonight and refactor later.

### Alt B: Turso (libSQL) instead of Neon
Keep SQLite semantics, get free remote hosting.

- **Pro:** Smallest code diff (`better-sqlite3` → `@libsql/client`).
- **Con:** Smaller ecosystem than Postgres, fewer escape hatches.
- **Con:** Still need somewhere to run the collectors and API.
- **Use this if:** You want minimal migration cost and are OK running the app
  server somewhere else (Vercel functions still work against Turso).

### Alt C: Supabase instead of Neon
Postgres + auth + storage + edge functions bundled.

- **Pro:** Single dashboard for DB + function logs.
- **Con:** Somya doesn't need auth or storage — most of Supabase's value is
  unused. Free tier pauses after 1 week of inactivity.
- **Use this if:** You later add user accounts, saved searches, etc.

---

## Migration steps (in order)

Each step is independently testable. Don't skip ahead; the order handles
dependencies.

### 1. Port SQLite → Postgres (biggest step)

Files that touch the DB:
- `src/db/index.js` — replace `better-sqlite3` with `pg` (node-postgres)
- `src/services/collect.js` — transactions use `BEGIN/COMMIT` instead of
  `db.transaction()`
- Anything calling `db.prepare(...).get()` / `.all()` / `.run()` — convert to
  parameterized `pool.query(sql, params)`

Schema changes:
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY` (or `GENERATED
  ALWAYS AS IDENTITY`)
- `datetime('now')` → `NOW()` or `CURRENT_TIMESTAMP`
- Boolean-ish `INTEGER NOT NULL DEFAULT 0` → `BOOLEAN NOT NULL DEFAULT FALSE`
  (optional; `smallint` also fine if you want to minimize app-layer changes)
- `TEXT` stays `TEXT`
- Indexes are identical syntax

Columns added since this file was first written (make sure your
`001_init.sql` includes them):
- `category TEXT NOT NULL DEFAULT ''` (+ `idx_jobs_category`) — identifies
  YC / HN-hiring rows as `'STARTUP'`, empty otherwise. See
  `src/services/category.js`.
- The retention sweep (`pruneStaleJobs(days)`) is pure SQL and ports cleanly
  — just replace the SQLite date arithmetic with Postgres equivalents
  (`date_posted < NOW() - INTERVAL '30 days'`).

Migration strftime expressions in `src/db/index.js::migrate()` (used by a
handful of one-shot backfills) translate to `TO_CHAR(...)` in Postgres;
re-express them at port time.

Migration tool: use a plain `.sql` file checked into `migrations/001_init.sql`.
Run once manually against Neon via `psql`. Don't add a migration framework —
the current additive-migration pattern in `src/db/index.js::migrate()` is fine,
just rewrite it against Postgres.

**Verify:** run `npm run collect` locally against a Neon dev branch, confirm
row counts match a fresh SQLite collect.

### 2. Split the API into Vercel functions

Current: `src/api/server.js` is one Express app with multiple routes.

Target: `api/jobs.js`, `api/stats.js`, `api/jobs/[id].js`, `api/health.js` —
each a Vercel serverless function. Vercel auto-routes from the `api/` folder.

- `/admin/collect` and `/admin/ingest` are write endpoints hit by the cron
  jobs. They should remain, still token-protected via `COLLECT_TOKEN`.
- The 30s in-memory cache in `src/api/cache.js` won't work across serverless
  invocations (cold starts drop the cache). Either:
  - Drop the cache (Neon query is fast enough at this volume), **or**
  - Move to Vercel's `stale-while-revalidate` response headers (cache at the
    edge, not in memory).

Express can also run on Vercel as a single handler if you don't want to split —
`api/index.js` exporting the Express app. Simpler migration, slightly worse
cold-start per route.

### 3. Deploy the React frontend to Vercel

The UI already lives at `web/` (Vite + React + TanStack Query). Set Vercel's
project root to `web/`, build command to `npm run build`, and output
directory to `dist`. The API fetch calls (`/jobs`, `/stats`, `/admin/*`)
are already same-origin relative paths, so there's no CORS work once the
Vercel functions at `/api/*` mount alongside the static bundle.

### 4. Move the 2 h collect cron to GitHub Actions

Create `.github/workflows/collect.yml`:

```yaml
name: collect
on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours UTC
  workflow_dispatch:        # manual trigger button
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run collect
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          FILTER_US:      'true'
          FILTER_SOFTWARE:'true'
          ENTRY_LEVEL_MODE: 'any'
```

`npm run collect` is already a one-shot script (HANDOFF.md §"Other ways to
run"). It needs to read `DATABASE_URL` instead of opening a local file — that
happens as part of step 1.

GitHub cron fires on a best-effort basis; actual firing can lag by 5–15 min at
peak times. That's fine for 2-hour cadence.

### 5. Move the 6 h scrape cron to GitHub Actions

Create `.github/workflows/scrape.yml`:

```yaml
name: scrape
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - working-directory: scraper
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npm run scrape
        env:
          INGEST_URL:    ${{ secrets.INGEST_URL }}      # https://<vercel>.vercel.app/api/admin/ingest
          COLLECT_TOKEN: ${{ secrets.COLLECT_TOKEN }}
```

The scraper pushes via HTTP POST to the Vercel API (existing contract), which
writes to Neon. No direct DB access from the scraper — keeps the boundary
clean.

### 6. Decommission `run-all.sh` and `src/scheduler.js` for production

- `run-all.sh` stays for local dev (unchanged).
- `src/scheduler.js` can stay in the code but should be **off by default in
  production**. Gate it behind `if (process.env.ENABLE_LOCAL_CRON === 'true')`
  or similar. Serverless functions don't run long-lived crons.

---

## Secrets to configure

| Name             | Where                              | Value                                             |
|------------------|------------------------------------|---------------------------------------------------|
| `DATABASE_URL`   | Vercel env + GitHub Actions secret | Neon connection string (use the pooled one)       |
| `COLLECT_TOKEN`  | Vercel env + GitHub Actions secret | Random 32-byte hex, gates `/admin/*` routes       |
| `INGEST_URL`     | GitHub Actions secret (scraper)    | `https://<vercel-domain>/api/admin/ingest`        |
| `FILTER_US`      | Vercel env + Actions env           | `true`                                            |
| `FILTER_SOFTWARE`| Vercel env + Actions env           | `true`                                            |
| `ENTRY_LEVEL_MODE`| Vercel env + Actions env          | `permissive` (see `src/config.js`)                |
| `RETENTION_DAYS` | Vercel env + Actions env           | `30` (drops rows older than N days at collect end)|

**Do not** commit any of these. Vercel has an env-var UI; GitHub Actions has
repo Settings → Secrets and variables → Actions.

---

## Deployment checklist (ordered)

- [ ] Create a Neon project, note the pooled + direct connection strings
- [ ] Run `migrations/001_init.sql` against Neon
- [ ] Port `src/db/index.js` to Postgres, keep behavior byte-identical
- [ ] Run `npm run collect` locally with `DATABASE_URL` pointing at Neon,
      confirm jobs populate
- [ ] Connect the repo to Vercel, set env vars, deploy
- [ ] Hit `https://<domain>/api/stats` — should return non-empty JSON
- [ ] Open `https://<domain>/` — UI should list jobs
- [ ] Add `collect.yml` workflow, add secrets, trigger manually via "Run
      workflow" button, confirm new rows appear
- [ ] Add `scrape.yml` workflow, trigger manually, confirm `meta`/`google`
      rows arrive via `/admin/ingest`
- [ ] Enable the schedule triggers (remove `workflow_dispatch`-only gate if you
      used one for testing)
- [ ] Wait 2 h, confirm first scheduled collect fires and writes to Neon

---

## Open questions for Somya

These require Somya's call before the next agent proceeds.

1. **Public or private GitHub repo?** Public = unlimited Actions minutes.
   Private = 2000 min/month, which **no longer fits** (see "Free-tier math"
   above — collect alone runs ~2,520 min/month). Options if the repo must be
   private: reduce cadence to every 3-4 h (+loss of freshness), pay GitHub
   Pro $4/mo for 3,000 min, or run the crons on a different free-tier runner
   (Fly.io machines / Railway / a home server). Is there anything sensitive
   in the repo that rules out public?
2. **Vercel free hobby tier is non-commercial only.** Does this qualify as
   personal use? (It does — it's Somya's job search tool — but confirm.)
3. **Keep `/admin/collect` as a public endpoint (token-gated) or remove it?**
   With GitHub Actions doing the scheduling, the API doesn't need a write path
   other than `/admin/ingest` for the scraper. Could remove `collect` entirely
   and run the collectors only in the Actions runner.
4. **Neon auto-pause:** Neon's free tier pauses the compute after 5 min of
   inactivity. First query after pause takes ~500 ms extra (cold start). For a
   personal tool, fine. Flag if latency becomes visible.
5. **Do you want email/Slack alerts when a cron run fails?** GitHub Actions
   sends email by default to the repo owner on failure. Anything fancier is
   extra work.

---

## Red lines (don't)

Same spirit as `HANDOFF.md`:

- Don't introduce Airflow, Prefect, Dagster, or any orchestrator. Cron is
  sufficient at this scale and for this DAG shape.
- Don't put the API on a 24/7 VM just to preserve `src/scheduler.js`. The
  scheduler was a convenient local-dev pattern, not a deployment target.
- Don't migrate to a paid tier without asking. Somya's constraint is $0.
- Don't add a second database (e.g. Redis for cache). Neon is enough.
- Don't rewrite the collectors to run "inside" Vercel functions. Functions
  have a 10–60 s timeout depending on plan; a full collect run can exceed
  that. Collectors belong in GitHub Actions.
- Don't host the Playwright scraper on Vercel. Chromium + serverless = pain.
  GitHub Actions runners have Chromium preinstalled; use them.
- Don't delete `run-all.sh` or the local SQLite path. Keeping local dev
  working is non-negotiable — it's how changes get tested before deploy.

---

## Appendix: file inventory added by this migration

```
migrations/001_init.sql                   # Postgres schema + indexes (incl. category col)
.github/workflows/collect.yml             # 2 h cron
.github/workflows/scrape.yml              # 6 h cron
api/                                      # Vercel functions (if split)
  jobs.js
  jobs/[id].js
  stats.js
  health.js
  admin/collect.js
  admin/ingest.js
vercel.json                               # build config if needed
HOSTING.md                                # this file
SPONSORSHIP_PLAN.md                       # planned USCIS-data classifier (hosting-neutral)
src/data/h1b-sponsors.json                # ← only if SPONSORSHIP_PLAN is executed; ~500 KB gzipped
```

And changed:
```
src/db/index.js                           # better-sqlite3 → pg
src/services/collect.js                   # transactions via pg
src/api/server.js                         # may be kept as single handler or split
package.json                              # + pg, - better-sqlite3 (eventually)
```

Local dev still runs `./run-all.sh` with SQLite — the Postgres path is
production-only, selected via `DATABASE_URL` being set.