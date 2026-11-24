# An apply agent: how it would plug in

Status: groundwork only. There is no agent today. This note says what an
agent may do, through which interface, and where the human step sits, so
one can be added later without touching how the queue works.

## The rule

**An agent never submits an application.** CURSOR.md forbids submitting
real applications, and the server enforces it: an agent can move a job to
`prepared` or `needs_you`, and nothing else. Only the user, signed in on the
web page, can set `submitted_by_you` (or `skipped`). The final submit is a
human click on the employer's own site.

## The queue

`apply_queue` (migrations/007_alerts.sql) holds one row per job the user
wants to apply to. Statuses:

| Status | Meaning | Who sets it |
|---|---|---|
| `queued` | The user wants to apply. | the user (web, Telegram `/apply`) |
| `prepared` | The agent did the prep (answers drafted, form filled in a tab, cover letter written). Waiting for the user to review and submit. | agent, user |
| `needs_you` | The agent got stuck (a question it can't answer, a CAPTCHA, an account to create). | agent, user |
| `submitted_by_you` | The user submitted it themselves. | **user only** |
| `skipped` | The user decided not to apply. | **user only** |

Every change, and every agent call (including refused ones and plain
reads), is a row in `apply_events`: who (`you`, `telegram`, `extension`,
`agent`), what, the status before and after, and when. The user sees it under
"History" on the Queue page.

## The interface an agent uses

Authentication: a bearer token with scope `agent`, made by the signed-in user
(`POST /api/me/agent-tokens`, needs a sign-in from the last 10 minutes; shown
once; revoked like extension tokens with `DELETE /api/me/tokens/{id}`). An
agent token reaches only `/api/agent/*`, never the extension's routes or the
user's profile, and an extension token can't reach `/api/agent/*`. Each token
belongs to one user; every query is scoped to that user, so another user's
item id is simply not found.

| Call | What it does |
|---|---|
| `GET /api/agent/queue` | The user's open items (`queued`, `prepared`, `needs_you`), at most 50, and `maySet: ["prepared", "needs_you"]`. Logged as a `list` event. |
| `POST /api/agent/queue/{id}` `{"status": "prepared" \| "needs_you", "note": "…"}` | Moves one item and stores a note (encrypted, at most 1,000 characters) for the user to read. Any other status, or an item already `submitted_by_you`/`skipped`, answers 403 and is logged as `refused`. |

That's all. There's deliberately no endpoint for the agent to submit,
delete, or read the user's profile or resumes through this token.

## Where the human approval sits

```
user queues a job ──▶ agent prepares ──▶ status: prepared ──▶ USER reviews and
 (web / Telegram)     (drafts, fills)     (note says what      clicks Submit on the
                                           it did)              employer's site
                                                                     │
                                                    user marks "I applied" ──▶ submitted_by_you
```

The approval step is the user's own click on the employer's page, then
"I applied" on the Queue page. An agent that fills a form in a browser tab
must stop before the submit button and set `prepared`, the same way the
extension's autofill never presses submit today.

## What an agent would still need (not built)

- Something to run it: the extension (a "Prepare" button per queued job that
  opens the job and fills it with the existing autofill, then calls
  `POST /api/agent/queue/{id}`), or a separate program holding an agent token.
- Answers it can't find in the profile go to `needs_you` with the question in
  the note; the user answers on the site, never the agent guessing
  (CURSOR.md §6: never guess sponsorship, qualifications or EEO answers).
- Rate limits per agent token, if an agent ever runs unattended.
