# AI job tags (role + visa sponsorship)

The collect cron asks a model (qwen3:8b on MINA) to read each **new or changed**
posting's JD and decide its role family and the employer's visa-sponsorship
policy. The verdict is written into the same `role_type`, `sponsorship` and
`restriction` columns the regex rules fill, in the same collect run, so the
board, filters, API and Vercel deploy work exactly as before. No new table,
column, migration, workflow or frontend change.

## How it works

`src/services/collect.js` → normalize (rule tags, as always) → dedupe →
**`src/services/ai-tagger.js`** → bulk upsert.

- **Same posting as stored** (same link, title and description): keeps its stored
  tags. No model call. This keeps each 2-hour run cheap, and stops the rules from
  overwriting an earlier AI verdict.
- **New or changed posting with a description**: newest first, one at a time, to
  the model (`src/services/ai-tags.js`). The model returns role, specialty,
  sponsorship reason and the verbatim JD sentence as evidence. `validate()`
  rejects answers whose evidence isn't really in the JD or doesn't support the
  verdict, and gives the model one correction.
- **Sponsorship mapping**: JD offers → `YES`; JD refuses → `NO` (and the
  board's no-sponsorship restriction); JD silent / case-by-case / transfers only →
  the employer's USCIS H-1B record decides (≥3 approvals → `YES`, else `UNKNOWN`),
  the same fallback the rules use; conflicting → `UNKNOWN`.
- **Role**: the model's family. If it says `OTHER`, the rule family is kept
  (the rules already admitted it as software, so one model answer doesn't hide it).
- **Fallback**: anything the model doesn't answer keeps the rule tags: MINA
  offline, the run's budget used up, or an answer rejected twice. Those postings
  are **not** retried later unless their text changes (there is no "reviewed"
  marker in the DB, by design).
- Long JDs are cut to ≤9,000 characters (opening + every sponsorship /
  authorization / clearance line), because MINA's Ollama context is 4,096 tokens
  and overflow silently drops the instructions.

Existing jobs already in the DB keep their rule tags; only postings that arrive
after you switch it on are AI-tagged. With 14-day retention the whole board is
AI-tagged about two weeks after enabling.

Numbers from real runs (Nov 2026): ~1,500 jobs kept per collect, of which 12–40
are new; qwen3:8b takes ~4–12 s per JD. The default budget (150 requests / 15 min)
covers that with room to spare.

## Settings

| Variable | Where | Meaning |
|---|---|---|
| `AI_TAGGING` | repo **variable** | `true` turns it on. Anything else = the old rule-only behavior. |
| `MINA_BASE_URL` | repo **variable** | MINA's OpenAI-compatible base, e.g. `https://devarshi-pc.tailefc5e0.ts.net/v1`, or several separated by commas, tried in order (see "Several PCs"). HTTPS required except `localhost`/`127.0.0.1`. |
| `MINA_MODEL` | repo **variable** | Default `qwen3:8b`. Every listed PC must offer it. |
| `MINA_API_KEY` | repo **secret** | A MINA model API key (`mina_…`) scoped to that model, used for every address. |
| `MINA_API_KEYS` | repo secret, optional | Instead of `MINA_API_KEY` when each PC has its own key: one per address, comma-separated, same order as `MINA_BASE_URL`. |
| `AI_TAG_LIMIT` | repo variable, optional | Max model requests per collect (default 150). |
| `AI_TAG_MINUTES` | repo variable, optional | Time budget per collect (default 15). |

A generic OpenAI-compatible provider also works: `AI_MODEL_URL` (full
chat-completions URL), `AI_MODEL`, `AI_API_KEY`. Setting `AI_MODEL_URL` selects it.

Vercel needs **nothing** new: it only reads the DB. (`/admin/collect` on Vercel
skips AI tagging, since functions can't wait minutes on a model.)

## Local

Put the four settings in the git-ignored `.env` (local MINA: `MINA_BASE_URL=http://127.0.0.1:8091/v1`).

```sh
npm run tags:mina      # check the model on 7 labeled postings (no DB)
npm run collect        # a real collect with AI tagging (SQLite unless DATABASE_URL is set)
DEBUG=1 npm run collect   # also logs every verdict: rule → AI, evidence quote
```

Each collect logs `tags.review` with `reused`, `requested`, `tagged`, `failed`,
`deferred`, `unavailable`, `roleChanged`, `sponsorshipChanged`, plus `used` (the
PCs that answered, in order) and `endpoints` (per PC: requests, ok, up/down/rejected).
A `tags.switch` warning is logged when a run moves to the next PC.

## Several PCs (failover)

Every PC that runs MINA can serve the tagger. List them in `MINA_BASE_URL`,
preferred first:

```
https://devarshi-pc.tailefc5e0.ts.net/v1,https://grafton-pc.tailefc5e0.ts.net/v1,https://avis-pc-1.tailefc5e0.ts.net/v1
```

- Before the first request, each address is checked in order (`GET /v1/models`,
  8 s): the first PC that answers and offers the model is used. An offline PC costs
  seconds, not a 90-second timeout.
- If that PC goes offline mid-run, the same posting is retried on the next PC.
- A PC that refuses the key is skipped. Only if every PC refuses does the run log
  `tags.failed`; only if none answers does it keep rule tags (`unavailable`).
- Adding or removing a PC is just editing the variable: no code change.

Each PC needs: MINA's model gateway running (port 8091), `qwen3:8b` pulled
(`ollama list`), Tailscale Funnel on for the gateway (`tailscale funnel --bg 8091`,
check with `tailscale funnel status`), and a key that PC accepts. MINA keeps keys
per install (`data/model_api_keys.sqlite3`, not synced between PCs): either copy
that file to the other PCs so they accept the same key (then `MINA_API_KEY` is
enough), or create a key on each PC and put them in `MINA_API_KEYS`.

Quick check of a PC from anywhere: `https://<pc>.tailefc5e0.ts.net/v1/models`
answers `401` without a key and `200` with one.

## Going live

1. MINA must be reachable from GitHub's runners over HTTPS. The gateway listens on
   port 8091 on the PC, so each PC exposes it with Tailscale Funnel (free; no other
   tunnel needed). At least one listed PC must be on during the collect runs.
2. Set the variables and secret above in GitHub → Settings → Secrets and variables → Actions.
3. Run **collect → Run workflow** once and check its `tags.review` log line.
4. If something's wrong, set `AI_TAGGING` to anything but `true`: the next run is back to rules only.

`backfill-derived` and `reclassify` keep AI sponsorship while `AI_TAGGING=true`.
`/admin/ingest` (Playwright scraper, extension sharing) still uses rule tags.
