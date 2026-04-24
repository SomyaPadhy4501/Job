# Sponsorship Classifier — USCIS H-1B Data Plan

Status: **Approved, not yet executed** (2026-04-24).

Read this after `HANDOFF.md`. `HOSTING.md` is **unaffected** — this plan adds
no runtime dependencies (no API calls, no ML model, no new hosting).

---

## Problem

Today ~96% of jobs in the DB show `sponsorship: UNKNOWN` (1,577 of 1,662 rows).

The current classifier (`src/services/classifier.js`) has only ~12 regex
patterns and only looks at the job description. That misses:
- Companies whose description doesn't mention visas at all (the common case).
- The 516 rows that have **no description text** at all (Workday, Microsoft,
  Goldman, PCSX, Netflix, Wipro, Deloitte, Phenom — those collectors don't
  fetch the detail page).

Result: the sponsorship column is nearly useless.

---

## Why USCIS H-1B data

When a company files for H-1B visas, **USCIS publishes the approval counts
per employer per fiscal year** as a free, public CSV — the "H-1B Employer
Data Hub" release. That data is authoritative: if Google got 7,000 H-1Bs
approved last year, Google sponsors. No amount of marketing copy on a job
posting beats a government filing record.

We use this dataset as a **deterministic, static, zero-runtime-cost signal**:

- If a company appears in the USCIS data with ≥3 recent approvals → lean YES.
- Otherwise → fall back to what the description says (or UNKNOWN).

### Not LLM / not API

**No model inference is used anywhere.** This plan is pure CSV ingest +
regex + hash-map lookup. Reasons:

- $0 ongoing cost.
- Deterministic: same input always produces same output.
- No runtime dependency — JSON ships in the repo.
- No secrets to manage.
- HOSTING.md architecture (Vercel + Neon + GitHub Actions) is unaffected.

---

## Data source

**USCIS H-1B Employer Data Hub** — not DOL LCA. LCA is *applications* (can be
speculative); USCIS Hub is *approved petitions* (actual sponsorships).

- URL: <https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub>
- Format: one CSV per fiscal year (FY runs Oct 1 – Sep 30).
- Size: ~200k rows / ~30 MB per FY.
- Columns (the ones we use): `Fiscal Year`, `Employer (Petitioner) Name`,
  `Petitioner City`, `Petitioner State`, `Initial Approvals`,
  `Continuing Approvals`, `Initial Denials`, `Continuing Denials`.
- License: US government public domain — safe to redistribute.

We pull the **last 2 fiscal years** (to smooth single-year anomalies and
handle mid-year fetches gracefully) and merge.

---

## File layout

```
src/
  data/
    h1b-sponsors.json       # ← generated; 50k companies, ~500 KB gzipped
  services/
    classifier.js           # ← modified: loads h1b-sponsors.json at init
    normalize.js            # ← modified: passes company_name to classifier
  db/
    index.js                # ← modified: reclassify-existing migration
scripts/
  refresh-h1b-data.js       # ← new; run manually once per quarter
SPONSORSHIP_PLAN.md         # ← this file
```

### JSON schema

```json
{
  "google": { "approvals_last_2fy": 7412, "latest_fy": 2025 },
  "anduril-industries": { "approvals_last_2fy": 34, "latest_fy": 2025 },
  "stripe": { "approvals_last_2fy": 189, "latest_fy": 2025 }
}
```

- Keys are the same normalized slugs our `normSlug()` produces — so `Google`,
  `Google LLC`, `Google, Inc.` all collapse to `google`.
- Values summed across all USCIS entries whose normalized name matches.

---

## Classifier behavior (new)

New signature: `classifySponsorship(description, companyName)`.

Order of precedence (first match wins):

1. **Explicit NO in description** → `NO`. *Always strongest.* A user should
   never apply to a "US citizens only" role thinking sponsorship is possible,
   even if the company files H-1Bs for other roles.
2. **Explicit YES in description** → `YES`.
3. **USCIS Hub lookup**: if `approvals_last_2fy >= 3` → `YES`.
4. **Else** → `UNKNOWN`.

### Why the threshold is 3, not 1 or 100

- `1`: noisy. Shell LLCs and one-off filings show up in the data. 1 approval
  could be a fluke.
- `100`: too aggressive. Would miss mid-size real sponsors (small startups
  that sponsor 3–10 people/year legitimately).
- `3`: filters shell companies, keeps legitimate small sponsors. Tune later
  if signal is still noisy.

### Why we don't use the data as a NO signal

A company with 0 USCIS filings might just be:
- Too small/new to have needed H-1B yet.
- Not hiring internationally this year (but would for the right candidate).
- A subsidiary with filings under the parent's name.

Marking them `NO` from absence of data would produce false negatives. We
stay conservative: USCIS data is a `YES` booster only. `NO` requires
explicit description language.

---

## Refresh mechanism

`scripts/refresh-h1b-data.js`:

1. Fetch the last 2 FY CSVs from USCIS.
2. Parse (stream-based; CSV is big but simple).
3. Normalize `Employer (Petitioner) Name` via our existing `normSlug`.
4. Aggregate: `approvals = Initial Approvals + Continuing Approvals`, summed
   across FYs and across subsidiary name variants.
5. Write `src/data/h1b-sponsors.json`.

Run cadence: **manually once per quarter** when USCIS releases new data.
Takes ~30 seconds. No cron — this is intentionally offline/manual.

Typical flow:

```bash
node scripts/refresh-h1b-data.js
git diff src/data/h1b-sponsors.json   # sanity-check the diff
git commit -am "refresh h1b sponsor data Q<n> <year>"
```

---

## Implementation checklist

| # | Step                                                                 | Time    |
|---|----------------------------------------------------------------------|---------|
| 1 | `scripts/refresh-h1b-data.js` — download, parse, aggregate, write    | 1.5 hr  |
| 2 | `src/services/classifier.js` — add `companyName` param + LCA branch  | 1 hr    |
| 3 | `src/services/normalize.js` — thread `company_name` into classifier  | 15 min  |
| 4 | `src/db/index.js` — one-shot reclassification migration on next boot | 30 min  |
| 5 | HANDOFF.md update — explain new file, refresh cadence, expected stats | 30 min  |
| 6 | Generate first `h1b-sponsors.json`, commit to repo                    | 15 min  |
| **Total** |                                                              | **~4 hr**, $0 cost |

---

## Edge cases + how we handle them

| Case                                         | Handling                                                                 |
|----------------------------------------------|--------------------------------------------------------------------------|
| Google / Google LLC / Google, Inc.           | `normSlug` strips `LLC / Inc / Corp / Ltd` → all collapse to `google`.   |
| Meta / Facebook (same company, different names) | Manual synonym map for ~20 high-value aliases in the refresh script.  |
| Amazon Web Services / Amazon.com Services / Amazon.com | All start with `amazon` → sum across prefix matches during aggregation. |
| Small startup not in USCIS data              | Stays `UNKNOWN`. Correct — we have no evidence either way.              |
| Defense contractor with heavy H-1B *and* "US citizens only" in description | Description NO wins (precedence rule 1). Correct.                       |
| Subsidiary filings under parent's name       | Synonym map; otherwise captured by prefix match when reasonable.        |
| Company name has non-ASCII chars / emoji     | `normSlug` strips to `[a-z0-9]` → safe.                                  |

---

## Expected impact

Rough estimate based on current DB distribution:

|                          | Before  | After (projected) |
|--------------------------|---------|-------------------|
| `YES`                    | 67      | **~900–1,100**    |
| `NO`                     | 18      | ~50–100 (regex expansion not included here) |
| `UNKNOWN`                | 1,577   | **~500–700**      |

Big tech, major finance, consulting, and most well-funded startups all file
H-1Bs and would flip to `YES`. Remaining `UNKNOWN` = small/early-stage
companies (no USCIS history), defense contractors whose listings don't
mention citizenship (we won't guess), and a long tail of niche employers.

---

## Out of scope (deferred)

These were considered but not included in this plan. Capture here so the
next agent doesn't re-evaluate from scratch.

- **Option A (regex expansion)**: still worth doing eventually, but Option D
  lifts UNKNOWN harder with less maintenance. If we do A later, it layers
  cleanly on top (description regex already has precedence over LCA).
- **Option B (LLM fallback)**: rejected on cost and dependency grounds.
  Revisit only if USCIS + regex together still leave >20% UNKNOWN.
- **Option C (description enrichment)**: would require adding per-job detail
  fetches to Workday/Microsoft/Goldman etc. Lots of traffic for ~243 rows of
  signal. USCIS data covers most of those companies anyway — not worth it.
- **Option E (company-level propagation)**: low uplift once Option D is in
  (since the same companies that would benefit from propagation are almost
  always in USCIS data too).

---

## Hosting impact: none

Confirmed against `HOSTING.md` (Vercel + Neon + GitHub Actions):

- **No new compute**: the refresh script runs on a developer machine, not in
  CI. The JSON file is committed and deploys like any other source file.
- **No new secrets**: USCIS CSV is public; no API key.
- **No new runtime dependency**: the classifier loads a static JSON at
  startup. Same memory profile as before.
- **No DB schema change**: `sponsorship` column already exists.

`HOSTING.md` is intentionally **not updated** by this plan.
