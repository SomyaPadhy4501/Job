# Handoff — Job Aggregator

Read this first if you're a new agent (Claude, Codex, or human) picking up
this codebase. It exists so you don't have to re-derive context.

---

### Done 2026-11-24 (Workday login on the server) — needs migration 010 before deploy
- One Workday email + password per user, set on the Autofill page ("Workday accounts" card, `web/src/components/WorkdayLogin.jsx`: generate, save, remove; the password is never shown again). Stored as encrypted `{email, password}` JSON (`Field::WorkdayLogin`, bound to the user id) in `workday_logins` (`migrations/010_workday_login.sql`). Routes in `crates/api/src/workday_login.rs`:
  - `GET /api/me/workday-login` → `{ email, set, updatedAt }` (no password); `PUT` `{ email, password? }` (password 12–128 chars with upper, lower, digit and symbol; left out = keep the saved one, required when none is saved); `DELETE` → `{ ok: true }`. Session + CSRF like every `/api/me/*` route.
  - `GET /api/autofill/workday-login` (bearer) → `{ email, password, updatedAt }`, all null when none is saved.
- While the table is missing these answer 503. Export lists the email and date only. Privacy page updated (the password is no longer extension-only). Tests: `workday_login_is_set_on_the_web_and_read_only_by_the_extension`, plus the routes in `every_per_user_route_refuses_another_users_data`.

### Done 2026-11-24 (extension needs no collect token)
- Workday collection and the boards' captures go through the connected account (`/api/capture/jobs`); the server forwards with COLLECT_TOKEN, which no browser holds any more. The popup's Collect token box is gone (an older install's saved token still works).
- Rows from a Workday page must link to Workday, are stored as source `workday`, and count against `WORKDAY_SHARES_PER_USER_PER_DAY` (default 20,000), apart from the 3,000 general share cap. `OWNER_SUBS` accounts aren't counted.
- Share uploads split at 200 rows or ~200 KB (the API takes 256 KB).
- The scrape workflow writes to Neon directly (DATABASE_URL, through src/services/ingest.js, shared with /admin/ingest), like collect. GitHub's COLLECT_TOKEN secret (rotated 2026-11-24) is no longer used by any workflow, so it needn't match Vercel's; only Vercel's own value matters (Node /admin and the Rust share route read the same variable).

### Done 2026-11-24 (Built In links, Workday token message)
- Built In links: a builtin.com link no longer overwrites an employer's link on upsert (pg + SQLite). Titles Built In cut short ("Full-stack Engineer 4" for "…, Enterprise Data Tech") match when one same-city posting fits.
- `fix-builtin-links.js` matches rows we already store from the employer first (the Workday rows from the extension, Greenhouse, …); `--stored-only` runs after every scrape (scrape.yml). Rows stored before this: run backfill-derived, step fix-builtin-links (dry run, then apply).
- Extension 1.18.1: "Run Workday now" says when the collect token is missing. Workday collection sends nothing until the owner pastes COLLECT_TOKEN (Vercel env) into the popup and saves.

### Done 2026-11-24 (job alerts, Telegram, apply queue) — not live until the owner steps below
- **Alerts** (`/alerts`, `crates/api/src/alerts.rs`): saved searches with the board's filters (role, level, sponsorship, restriction) plus companies, title keywords and locations; instant (after each collect), daily or weekly; sent to the user's linked Telegram chat (email alerts were removed 2026-11-24; making an alert needs a linked chat). Name and filters are encrypted (`Field::AlertSpec`). `collect.yml` step "Send job alerts" runs `.github/scripts/send-alerts.sh` after a successful collect: `POST /api/cron/alerts` with `CRON_SECRET`, 10 alerts per call, 30 s apart while `remaining > 0`. Each alert sends jobs first seen since it was made that it hasn't sent (`alert_sent_jobs`), at most 10 per message plus a link to the board. No linked chat or no bot token: nothing is sent and the matches wait for the next run.
- **Chat** (`crates/api/src/chat.rs` = channel-agnostic commands, `telegram.rs` = adapter): link with a one-time code from the Alerts page (`/start CODE` via the t.me deep link, or `/link CODE`); `/jobs`, `/alerts`, `/pause`, `/resume`, `/apply <number|link>`, `/unlink`. The webhook checks `X-Telegram-Bot-Api-Secret-Token`, answers private chats only, and replies inside the webhook response. Chat ids are encrypted and found by an HMAC (`chat-address/v1`). WhatsApp later = a `whatsapp.rs` adapter + `Channel::WhatsApp`; its replies within 24 h of the user's message are free, but alerts outside that window are paid template messages, so it'd be reply-only.
- **Apply queue** (`/queue`, `crates/api/src/queue.rs`): `queued`/`prepared`/`needs_you`/`submitted_by_you`/`skipped`, every change logged in `apply_events`. Extension 1.17.3 shows the next 5 in the popup (read only, `GET /api/autofill/queue`). Agent groundwork: tokens with scope `agent` (`POST /api/me/agent-tokens`) reach only `/api/agent/queue*` and can set only `prepared`/`needs_you`; the user alone sets `submitted_by_you`. Design: `docs/agent-apply.md`.
- Migrations `migrations/007_alerts.sql` and `008_alerts_telegram_only.sql` (Telegram-only default, strips `email` from old alerts; run migrate.yml → apply, before deploying). Tests: `crates/api/tests/api.rs` (`alerts_belong_to_their_owner_only`, `the_queue_is_private_and_an_agent_stops_at_prepared`, `the_alert_run_sends_new_jobs_once` against a fake Telegram, `telegram_links_one_account_per_chat_and_answers_commands`; new routes added to `every_per_user_route_refuses_another_users_data`).
- Rotating `DATA_KEYS` changes the derived keys: linked chats must link again.
- Follow-up: an "Add to queue" button on board rows (`JobsTable.jsx`/`CompanyGroups.jsx`); today jobs reach the queue from Telegram (`/apply`, the Queue buttons) or a pasted link.

**Owner steps for alerts (not done; nothing is sent until they are):**
1. Run the `migrate` workflow with `apply` (adds the 007 tables).
2. (Removed: email through Resend.)
3. Vercel → project `job` → Settings → Environment Variables: `CRON_SECRET` (if not already set; 16+ random characters).
4. GitHub → repo → Settings → Secrets and variables → Actions: `CRON_SECRET` (same value as Vercel). Until it's there the alert step does nothing.
5. Telegram: in Telegram open **@BotFather** → `/newbot` → name + username → copy the token. In Vercel set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without @) and `TELEGRAM_WEBHOOK_SECRET` (16+ of A–Z a–z 0–9 _ -). Redeploy, then register the webhook once from your own terminal: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=https://job-two-xi.vercel.app/api/telegram/webhook -d secret_token=<SECRET> -d 'allowed_updates=["message","callback_query"]'` (`callback_query` carries taps on the "Queue" buttons).
   **Done 2026-11-24:** bot `@us_swe_jobalerts_bot` ("US SWE Job Alerts"), webhook registered with both update types, Vercel variables set, `CRON_SECRET` in GitHub matches Vercel. Set once through the Bot API (not in code; re-run if the bot is recreated): `setMyCommands` (jobs, alerts, apply, pause, resume, help, unlink), `setMyShortDescription`, `setMyDescription`, and `setMyProfilePhoto` with `web/public/icon-maskable-512.png`.

### Done 2026-11-24 (security audit)
- Roles live in `crates/api/src/roles.rs`: `Role::of` (User, or Owner when the Google sub is in `OWNER_SUBS`) and an `Owner` extractor; owner-only handlers take `Owner`, so others get 404. `/api/auth/me` also returns `role`.
- Session and sign-in nonce cookies are `SameSite=Strict` (sign-in uses GIS popup mode, so nothing cross-site needs them). New test `every_per_user_route_refuses_another_users_data` calls every `/api/me/*` and `/api/autofill/*` route as another user: all 404, nothing changes. **New per-user routes must be added to it.**
- Node `/admin/*`: deny by default. With `COLLECT_TOKEN` it's compared in constant time; without one, only a non-production server answering a loopback request works (Vercel answers 503). Public routes cap page (1000) and filter length (200); async errors are a bare 500 (they used to crash the process).
- Links: normalize drops non-http(s) `apply_url`; the web app renders job links through `webHref` (`web/src/safe-url.js`). `vercel.json` adds HSTS and `X-Frame-Options: DENY`. Dependencies: `npm audit fix` in both packages, plus a `qs` override.

### Done 2026-11-24 (Greenhouse codes per company, Workday create account)
- Greenhouse codes come only from mail naming the company being applied to: the extension sends the board slug (`JobApplicationPages.greenhouseBoard`: path, or `for` on embedded forms) and the page title's company; `gmail::greenhouse_company_matches` checks the subject and the start of the text (letters and digits only). Gmail is searched with `after:<now-15 min>`, up to 10 messages.
- Workday create account is automated at the owner's request (extension 1.20.3): fills email + both passwords, ticks `createAccountCheckbox`, presses `createAccountSubmitButton` once, under the same conditions as Sign In (user interacted, tab visible, no earlier failure). With a CAPTCHA on the form it fills only. Failure (form still there after 10 s) is recorded like a failed sign-in.
- `test/extension-autofill-live.cjs --live` covers sign-in, create account, the CAPTCHA case and a Greenhouse code fill through the fake portal (all pass). Not yet run against a real Workday tenant or a real Greenhouse email.

### Done 2026-11-24 (Gmail connector)
- Settings → **Connectors** → Connect Gmail (`web/src/pages/Settings.jsx`). Replaces the extension's own implicit-flow Gmail sign-in (`response_type=token`, no PKCE, no refresh token), which never shipped because `gmailClientId` was empty.
- Server side, OAuth 2.0 authorization code + **PKCE (S256)** + **OIDC**: `crates/accounts/src/gmail.rs` (client, PKCE, Gmail reading, code/link picking) and `crates/api/src/connectors.rs` (routes). `POST /api/me/connectors/gmail/start` seals `{state, verifier, nonce, exp}` with AES-GCM bound to the user id into `__Host-jb_gmail` (HttpOnly, SameSite=Lax, 10 min; the session cookie is Strict so it isn't sent on Google's redirect). `GET /api/connectors/gmail/callback` checks the cookie, `state` (constant time), trades code + verifier + client secret, verifies the ID token (Google keys, `aud` = Gmail client, nonce), requires `gmail.readonly` in the granted scopes (else revokes), and redirects to `/alerts?gmail=<word>#connectors` with `Referrer-Policy: no-referrer`. A reconnect revokes the replaced grant.
- `gmail_connections` (migration 009): refresh token and Gmail account encrypted (`Field::GmailGrant`), access token cached encrypted (`Field::GmailAccess`) until a minute before expiry. `invalid_grant` on refresh deletes the row (Settings shows Not connected). Disconnect and account deletion revoke at Google. Export lists the connected address only.
- Extension 1.20.0: `gmail.js` asks `POST /api/autofill/gmail/code` / `/verify-link` with the autofill token (skip list of used message ids stays in `chrome.storage.session`), re-checks the code shape and the link (https, this tenant, verify path). `identity` permission, Google host permissions and `config.js` removed. Popup card links to Connectors.
- Limits: 20 connect starts and 600 Gmail lookups per user per day. Tests: `cargo test -p accounts gmail`, `crates/api/tests/api.rs` `gmail_*` (fake Google: PKCE, state, nonce, scope, cross-browser, revocation), `test/extension-gmail.test.js`.
- Not verified: a real Google consent round trip (needs the owner's client, step 2 under "Not verified / open").

### Done 2026-11-24 (closed-job detection)
- Closed postings now leave the board within ~6 hours instead of lingering until retention. `src/services/closed.js`, run from `collectAll` after the upsert.
- Rule: when a company's fetch succeeds with a complete, non-empty listing, each stored row of that source and company that nothing listed this run gets `missed_runs + 1`. At 2 the row is deleted. A row counts as listed if its link is in *any* collector's answer this run, or anything updated it since the run started (another source's copy, a scraper or extension ingest). So a job another source still lists is never deleted, whichever source inserted it. Any sighting resets the count. Failed, empty or `partial` answers never count. Neither does a company where more than half its rows (and more than 2) would go missing at once: that's logged as `closed.suspicious` and left alone. Two boards with one name: if either fails, neither is judged.
- Opt-in per collector with `fullListing: true`: greenhouse, lever, ashby, workable, recruitee, pinpoint, gem (one request returns the whole board); bamboohr, rippling (one list request has the whole board, details only add text); smartrecruiters (paged, but now marks a cut-short listing `partial`). Left out: workday, pcsx, microsoft, amazon, uber, oracle_hcm, capgemini, wipro, goldman_sachs, jibe, eightfold, netflix, bytedance (search, caps, or a failed page that keeps going), jsonld (lastmod filter, `maxDetail`), getro and the aggregators. Also apple and microsoft, which the scraper ingests under the same source name. A test checks that no opted-in source shares a name with a scraper target or `extension`.
- Needs `migrations/006_missed_runs.sql` on Neon. Until it's applied, the step logs `closed.skipped` and the run carries on. SQLite adds the column at boot.
- Known gap: if the only other source still listing a job fails two runs in a row while the employer's board drops it, the row goes. It comes back on that source's next good run.
- First live run (collect run 45373176374, 2026-11-24): closed 0, counted 190 misses, held back 107 companies as suspicious. The cause: the step ran before the retention sweep, which deleted 14,771 rows past 14 days in that same run (backlog from before pruning worked). Those rows made most companies look half-closed. Closing now runs after the sweep. Check the next scheduled run's `collection.closed` / `closed.suspicious` lines.

### Done 2026-11-24 (CURSOR.md T2–T5, collector hardening)
- T2: failed silent Gmail re-auth says "Reconnect Gmail in the extension popup to fill codes." once and stops; code-note colors updated (extension 1.17.2). T1 still waits for the owner's Gmail OAuth client ID.
- T3: updater restarts browsers holding a pre-1.16 copy (`--restore-last-session`); fixed a one-process `Count` bug found in a Playwright sandbox test. macOS script not yet run on a Mac.
- T4: resume-title words (+5) break ties between resumes of one family. T5: Profile Save off until an edit; Welcome uses `ResumesBody`.
- Collector: `collectAll` now awaits the Postgres store (prune and run log never completed before); upserts in 250-row transactions with per-row fallback; runs exit 1 when nothing was fetched or `DATABASE_URL` is missing; first-page failures fail the company. Wayfair is collected via `jsonld` (sitemap + JSON-LD). Collect and scrape are triggered every 30 min and run when 170+ min have passed (`.github/scripts/due.sh`), i.e. every 3 hours.

## Current state and next work (updated 2026-11-24) — START HERE

**Live:** https://job-two-xi.vercel.app (Vercel project `job`, GitHub
`SomyaPadhy4501/Job`). `main` = `fix/panw-staff-and-edge-cases` (kept in
step); the owner asked to push straight to `main` with no PRs. Push to
`main` first, then the branch: pushing both at once makes Vercel build only
a preview first.

**What exists now** (details in "Rust backend" below):
- Rust `/api/*` function (`crates/`, `api/server.rs`): Google sign-in,
  sessions, resumes, encrypted profile + answer bank, extension tokens,
  export/delete, `/api/autofill/*` (bearer), `/api/capture/jobs` (users share
  listings → forwarded to Node `/admin/ingest`), daily cleanup cron. Node
  still serves `/jobs`, `/companies`, `/stats`, `/admin/*`.
- Web (`web/src`): sign-in is required for everything except `/privacy`
  (`App.jsx` → `pages/Landing.jsx`). New accounts go to `/welcome`
  (`pages/Welcome.jsx`: resume → about you → job-board defaults → extension).
  Profile has `board` defaults (role/level/sponsorship/restriction/view,
  validated in `crates/accounts/src/profile.rs`); `pages/Board.jsx` applies
  them when the URL has no filters. Production builds redirect one-off
  `*.vercel.app` deploy URLs to the main host (`web/src/site.js`,
  `main.jsx`): Google sign-in only works on registered origins.
- Extension (`extension/`, v1.14.0, served as a zip from `/autofill`, built
  by `web/scripts/pack-extension.mjs`): autofill on Greenhouse/Lever/Ashby/
  Workday automatically, any other site via popup "Autofill this page"
  (per-site optional permission); resume picker; Ashby Yes/No clicked via
  `safeButton` (no `guardedClick` exists, despite older notes);
  "this country"/"country where the job is located" = US; after the user
  submits, unsaved custom answers are held per tab (`autofill:holdAnswers`/
  `takeAnswers` in `autofill-api.js`, `chrome.storage.session`, 30 min) and
  offered in a small card (`offerHeld` in `autofill.js`). Light UI in the
  panel and popup.

**Production config (done):** Vercel env has `GOOGLE_CLIENT_ID`, `DATA_KEYS`,
`CRON_SECRET`, `STORAGE_DRIVER=s3` + `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/
SECRET_ACCESS_KEY` (Backblaze B2, bucket `jobboard-resumes-7k3q9x`,
`us-east-005`; R2 was rejected: the owner won't add a credit card anywhere),
`SIGNUPS_OPEN=true`, `INGEST_URL`. Migration 004 applied to Neon. Google
Cloud project "Job Board" (`job-board-515704`), client "Job board web",
origins `https://job-two-xi.vercel.app` + `http://localhost:5173`; consent
screen is still in **Testing** (only the owner's Gmail can sign in).

**Done 2026-11-24 (second session):**
- Deploy of `bb125ae` confirmed: `/downloads/extension.json` said 1.10.0 and
  `/api/health` was all true.
- Merged the TikTok/ByteDance collector (`src/collectors/bytedance.js`); its
  title gate now passes "Senior" titles so `levelVerdict` reads the posting,
  like every other collector.
- Added Caterpillar (`cat`/wd5), Verizon (`verizon`/wd12) and WEX
  (`wexinc`/wd5) on Workday. TD Bank was already wired.
- Extension 1.11.0: location search boxes (Ashby "Where are you currently
  located?", Greenhouse "Location (City)") type the city and pick the one
  suggestion matching city + state + country (`pickPlace` in
  `autofill-fields.js`; ambiguous = nothing picked, box cleared). Date
  pickers (Ashby "When can you start?") get the earliest start date as
  MM/DD/YYYY. Verified live on OpenAI's Ashby and Figma's Greenhouse forms.
- Save-your-answers: no longer needs the panel opened. Answers are held on
  every step ("Next", "Save and continue") and on submit, merged per tab,
  and offered once the page confirms (new confirmation text, or the form
  gone) or on the next page. Nothing is held unless the extension is
  connected. `test/extension-autofill-live.cjs` has a two-step fixture for
  it (and no longer clicks the popup's removed portal "Save" button).
- `GET /api/autofill/form-schema?url=` (`crates/api/src/form_schema.rs`):
  Greenhouse board API + Ashby `ApiJobPosting` -> `{fields:[{name,label,
  required}]}`, cached an hour per instance. The extension passes it to the
  adapter when the panel opens.
- `web/dist` is no longer tracked; merged worktrees removed.

**Done 2026-11-24 (third session; plan in the session's plan file):**
- **Resume preview** (`web/src/components/PdfViewer.jsx`, `DocxViewer.jsx`):
  Preview beside Download. pdf.js 4.10 on canvases (same-origin worker, no
  eval; cMaps/standard fonts copied to `/pdfjs/` by a Vite plugin), Word via
  docx-preview in a shadow root. Both lazy-loaded. `vite preview` now sends
  `vercel.json`'s headers (plugin `vercelHeaders`) and proxies `/api`.
- **LaTeX editor** `/resumes/latex[?id=]` (`web/src/pages/LatexEditor.jsx`,
  `web/src/latex/`): CodeMirror + Siglum (`@siglum/engine` 0.2.2, TeX Live
  2026, pdfLaTeX) in the browser. Engine code (busytex.js/.wasm, xzwasm.js)
  is pinned to release `tl2026-0cc2592f50103429` and SHA-256-checked before
  it runs (`engine.js`; to upgrade, change RELEASE + hashes from that
  release's runtime.json and ENGINE_VERSION). Only `/resumes/latex` and
  `/siglum/*` get the relaxed CSP (`vercel.json`); the editor is reached by
  full page loads. SwiftLaTeX was rejected (server dead, TL2020).
  Template uses lmodern (T1 without cm-super).
- **LaTeX API** (`migrations/005_resume_sources.sql`, `crates/api/src/resumes.rs`):
  `PUT /api/me/resumes/{id}/latex` (multipart PDF + source, If-Match = file
  sha, own quota `REPLACES_PER_DAY`=50, new key reserved in
  `object_deletions`, old object queued by trigger), `GET/PUT …/source`,
  optional `source` part on upload; resumes carry `fileSha256`, `hasSource`,
  `sourceStale`. **005 must be applied to Neon before this code deploys**
  (every resume query reads `resume_sources`).
- **Extension 1.12–1.14:**
  - Education/experience from the profile (`autofill-fields.js` education
    block: standalone questions, degree levels with tiered option matching,
    school/major exact-name match, per-control date formats; profile dates may
    carry a day). Workday section ids fixed. Honeypot fields never filled.
    Verified live on Discord's Greenhouse form (school typed search, M.S. →
    Master's Degree, discipline).
  - **Manifest `key`: stable extension ID `deleknoaeibijjmfngfobapnpbekhcel`.**
    Updating from ≤1.11 = remove + reload + reconnect once (the Autofill page
    says so). Private key at `C:\Users\aryan\job-board-extension-key.pem`
    (outside the repo; only needed to pack a .crx).
  - Workday sign-in (`autofill-login.js`, own manifest entry, top frame):
    one job site password set in the popup, kept only in the worker's
    IndexedDB; ledger in `chrome.storage.session` (≤3 fills/company/10 min, no
    auto attempt after a failure until the password changes).
  - Gmail (`gmail.js`, `autofill-codes.js`): codes and Workday verify links,
    asked from the portal's Gmail connector (Alerts & Connectors tab); **off
    until `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` are set on Vercel**.

**Done 2026-11-24 (fourth session):**
- The 403s were Vercel's automatic DDoS mitigation challenging the owner's
  own IP (Firewall -> Persistent Actions); it expired on its own. IP bypass
  rules need Pro. Bursts of requests from one IP (test runs) can retrigger it.
- Extension 1.17.0: Ashby radio groups (`fieldset.ashby-application-form-input-radio-group`)
  are question boxes, and their option text comes from sibling `label[for]`,
  so Veteran/Gender/Race radios fill (checked live on OpenAI's form). Wider
  wordings for gender, race, Hispanic/Latino, disability, veteran, visa,
  work authorization and "how/where did you hear about ___". The panel no
  longer has "Save my response" checkboxes: new answers are offered only by
  the after-submit card (`offerHeld`).
- Per-resume history: `PUT /api/me/resumes/{id}/history` stores a resume's
  own education/experience in its parsed blob (a reparse replaces it);
  `/api/autofill/profile` returns `history[resumeId]`, and the extension
  fills with the attached resume's history (profile lists as fallback).
- Profile page: card sections, Yes/No buttons, on-site as a Yes/No over
  `workMode` (No = remote), address search via Photon (photon.komoot.io,
  allowed in the main CSP's connect-src; Google Places needs billing), and
  an "Education & experience" card with a tab per resume.
- Not shipped: `web/public/update-extension.ps1` browser-restart change
  (restarts the browser for copies < 1.16); written, never tested end to end.

**Not verified / open:**
1. Production smoke tests still not run (they need the owner signed in in
   the in-app browser; Google's popup only opens from the owner's own click):
   resume upload/download/delete on Backblaze, the cleanup cron (run it once
   from Vercel -> Settings -> Cron Jobs), and listing sharing end to end.
2. Gmail setup (owner) — the connector is built (Alerts & Connectors tab, see
   "Done 2026-11-24 (Gmail connector)"); it stays off until:
   a. A **separate** Google Cloud project (so the sign-in consent screen can
      still be published without restricted-scope review): enable the Gmail
      API; consent screen in **Testing** with scopes `openid`, `email`,
      `gmail.readonly` and the owner as test user; OAuth client type **Web
      application** with redirect URIs
      `https://job-two-xi.vercel.app/api/connectors/gmail/callback` and
      `http://localhost:5173/api/connectors/gmail/callback`.
   b. Vercel env (Sensitive): `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
      (optional `GMAIL_REDIRECT_URI`; default `$SITE_URL/api/connectors/gmail/callback`).
   c. Apply `migrations/009_gmail_connections.sql` (migrate.yml), deploy, and
      reload the extension (1.20.0).
   Then confirm live: the real From addresses (Workday
   `<tenant>@myworkday.com`, Greenhouse `*@*greenhouse*.io`) and Workday's
   verify-link path (`/verif|activat|confirm/`). Before letting anyone but
   test users connect, Google requires restricted-scope verification **and a
   CASA security assessment** for `gmail.readonly` held server-side; until
   then the consent screen stays in Testing (100 test users max).
3. Workday sign-in on a real tenant is only fixture-tested: whether Workday
   accepts the scripted press on `click_filter`, and its failure/verify
   messages, need the owner's own account. If scripted presses are ignored,
   the panel already falls back to "Click Sign In".
4. Workday My Experience (school prompt, month/year boxes) is fixture-tested
   only (needs a signed-in account to reach).
3. Owner to do: publish the Google consent screen when opening sign-ups;
   move `C:\Users\aryan\job-board-secrets-BACKUP.txt` into a password
   manager; enable Vercel 2FA; decide on server-side gating of `/jobs` and on
   `SHARING_OPEN` / `OWNER_SUBS` / `MAX_USERS` (see doubts below).
4. Plan Part C (port the Node backend and collectors to Rust) is dropped
   (owner's call, 2026-11-24): Node keeps the job API and the collectors.
   Don't propose it again.
5. `.claude/worktrees/priceless-leakey-117b83` still holds an uncommitted,
   abandoned `extension-autofill/` draft; delete it once the owner agrees.

**How to test locally (Windows, no MSVC):** `docker compose run --rm cargo
test --workspace` (Rust + Postgres); `docker compose up -d api` (dev API on
:4100, email-only dev sign-in, `.env` holds the Google client id); `cd web &&
BOARD_API=https://job-two-xi.vercel.app npx vite` (board data from the live
site). Node tests on Node 26 need the node:sqlite shim
(`NODE_OPTIONS=--require <shim>`; better-sqlite3 has no Node 26 build);
`npm ci --ignore-scripts` if better-sqlite3 fails to compile. Live extension
checks: load `extension/` into Playwright Chromium from
`scraper/node_modules/playwright` with `--load-extension`, connect with a
token from the local API, fill real public forms with all network aborted
after load and submits blocked. Never submit a real application.

**Owner preferences:** never auto-submit applications or guess
sponsorship/qualification answers; no credit cards on any service; prefers
the agent to drive the browser for setup; communicates in English/Hinglish.

### Doubts, risks and known gaps (honest list, most important first)

**Not verified live**
- Listing sharing end to end in production (extension → Rust
  `/api/capture/jobs` → Node `/admin/ingest` over the public URL with
  `COLLECT_TOKEN`): only tested locally with a fake ingest server.
- Resume upload to Backblaze from production: health says `storage: s3`,
  but no real upload/download/delete was done on prod. Do one, and check
  the file disappears from the bucket after deleting it.
- Daily cleanup cron (`/api/cron/cleanup`) has never run on Vercel.
- Google sign-in works for the owner (confirmed by them); nobody else can
  until the consent screen is published.

**Autofill doubts**
- Save-after-submit detection is a heuristic (`onSubmitLike` in
  `extension/autofill.js`): a `submit` event, or a click on a button whose
  text starts with submit/send/apply/finish/complete. A final button with
  other wording ("Next" on the last step) is only held, and offered on the
  next page load. A failed submit followed by leaving for another job in the
  same tab can offer that unsubmitted form's answers.
- Held answers are keyed by tab id; a confirmation page in a new tab, or
  after 30 min, loses them.
- "This country" / "the country where the job is located" is read as the
  US because the board is US-only. On non-US jobs (via "Autofill this page"
  on other sites) that would be wrong. It is marked "check it" in the panel.
- `guardedClick` blocks form submission while clicking Ashby Yes/No. It
  worked on OpenAI's live form; if Ashby changes markup it may need updating.
- Saved answers match only on the normalized exact question wording
  (`savedAnswer` in `autofill-fields.js`); reworded questions won't match.
- Company scope uses a URL slug (Ashby/Lever path, Greenhouse `for=`, the
  Workday subdomain), so the same company on two ATSs gets two names.
- Still left for the user: Greenhouse phone (the form doesn't keep the
  value), school/degree dropdowns, EEO unless set.
- Generic (company-built) forms are only tested on a fixture page; Tesla
  blocks headless browsers and Amazon needs a login, so both are untested.

**Product / security doubts**
- The sign-in wall is front-end only. The Node API (`/jobs`, `/companies`)
  is still public, so anyone can fetch job data directly, and search engines
  now see only the landing page. Gate on the server if that matters.
- Every signed-in board visit now calls `/api/auth/me` and
  `/api/me/profile`, which wakes Neon. Watch Neon Free's 100 compute-hours
  a month (shared with the collector).
- Backblaze B2 free tier: 10 GB, plus daily free caps on API calls.
  Without a card, going over blocks requests instead of billing. Each
  autofill downloads the resume (one download call). Fine for a few users;
  check B2 "Caps & Alerts" before opening sign-ups.
- Listing sharing is open to every signed-in user (`SHARING_OPEN` default
  true, 3000 listings/user/day). Links must be on the page's own site or a
  known ATS, but a user could still push junk listings from their own
  site. Consider turning it off, or allowlisting sharers.
- `SIGNUP_ALLOWLIST`, `OWNER_SUBS` and `MAX_USERS` are not set (MAX_USERS
  defaults to 500). The owner usage panel needs `OWNER_SUBS`.
- Secrets exposure: `DATA_KEYS` and the B2 application key each appeared
  once on screen during setup; those screenshots are in the setup chat's
  history on the owner's PC. Low risk, but you can rotate:
  `DATA_KEYS=1:<old>,2:<new>` (old values re-encrypt on next write), and
  make a new B2 key and delete the old one.
- The Vercel Rust runtime is in beta; cold-start time and binary size were
  never measured.
- The resume parser is rule-based (`crates/accounts/src/parser/`):
  two-column PDFs and unusual layouts parse poorly; scanned PDFs give
  "no text".
- Extension distribution is load-unpacked (developer mode warning, manual
  updates). The Chrome Web Store ($5 once) would fix both.

**Code / repo hygiene**
- Profile page: for an account saved before the `board` field existed, the
  Save button can show as enabled before any edit (the draft adds empty
  board defaults). Harmless; clears after one save.
- The Welcome step 1 embeds the full Resumes page, so its heading repeats.
- The level rework (`6e70b61`: seniority read from posting text, 12 boards
  moved to cloud collectors) is now live on `main`; watch the next collect
  runs for count changes.
- The live extension test scripts used during setup weren't saved in the
  repo (only `test/extension-autofill-live.cjs`, which uses a stub API).
  Recreate them from the "How to test locally" notes above.

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

**Current state (2026-11-23):** `COMPANIES` holds **1,183 boards**: 1,057
after merging the two branches below, 7 security boards, 96 employers mined
from the new-grad lists, speedyapply's AI list, 9 Jibe career sites, one
Pinpoint board (Confluence Technologies) and 12 boards moved off the browser
extension. The live board showed 904 visible rows with
every filter off (783 in the default view), from 16,480 stored.

**Changed 2026-11-23 (branch `fix/panw-staff-and-edge-cases`):**
- Merged `feat/expand-ats-coverage` (179 more boards, including Cisco on Workday, Okta, Zscaler, SentinelOne, Tenable, Wiz, Snyk, Tanium and 1Password; 5 repointed and 22 dead ones dropped) and `claude/dreamy-leakey-8f1afb` (USCIS sponsor data refreshed to FY2025–26). Both were finished on 2026-11-02 but never merged into `main`. `fix/ci-and-strict-yoe` is an older branch that `main` superseded (d720b24 ported what it kept), so it was not merged.
- **Level comes from what the posting says, not the title alone** (owner's call; replaced a first, Palo-Alto-only exception the same day). Titles mean different things at different employers: Palo Alto Networks hires new grads as "Staff Software Engineer", Walmart's "Software Engineer III" asks for 2 years, and startups call a 2-year role "Senior". The generic `staff` rule had dropped every such posting before its description was read; the board held 0 Palo Alto Networks rows that day. (The rest of that gap was the date and dedupe issues below: its 20 plain "Software Engineer" postings had collapsed into one undated row that cycled in and out of the 7-day window.) Now, in `normalize.js`:
  - `MANAGEMENT_REJECT` (manager, director, head of, VP, chief, supervisor, distinguished) and internships are rejected whatever the posting says.
  - `SENIORITY_WORDS` (senior, sr, staff, principal, lead, architect, III+) are kept only if `levelVerdict` finds the posting puts the role in range: a new-grad track in the title (`NEW_GRAD_TRACK`) or text (`NEW_GRAD_TEXT`: "new grad", "recent graduates", "graduating in 2027", "class of 2027"…, not boilerplate like "early career programs"), or a main requirement of at most 2 years with nothing of 5+ years anywhere. The main requirement is the one tied to a bachelor's or master's degree when given, else the highest stated: Palantir's "3+ years of professional development; 1+ years of networking" is 3, not 1.
  - Plain titles keep the lowest stated minimum, as before.
  - `passesLevel(title, mode)` is the title-only gate collectors use before per-job description requests. It now passes seniority words so their descriptions get read, and `levelRank` puts them last in each collector's capped detail budget. `prune-rejected.js` judges stored rows with the same verdict against their stored description.
  - Replayed on 13,083 live postings from 39 boards (retention off): 443 kept before, 447 after. Added: Pinterest "Sr. MLE", Rivian "Sr. Power Electronics" and Cloudflare "Senior SWE", whose postings ask for 2+ years; Databricks "Staff MLE", whose posting says "2-8 years"; Linear "Product Engineer", a plain title the old reader misread. Dropped: Perplexity's "Member of Technical Staff", which asks for 3+ years.
- **The years reader** (`experience.js`) had three bugs, which hit plain titles too. "What we're looking for: 8+ years of … experience" and "more than 5 years of experience" were read as company history ("for 8 years, Scale has been…"), so the requirement was dropped. A lead-in followed by experience now counts (`EXPERIENCE_AFTER`). A range's upper end was also counted as a second minimum ("2-4 years" read 2 and 4); it now asks for 2. `experienceProfile` returns `{ min, max, top, degree }`, and `extractExperience` still returns `{ min, max }`.
- **Escaped HTML.** Greenhouse's `content=true` sends the markup escaped (`&lt;p&gt;8+&amp;nbsp;years`), and `stripHtml` stripped tags before unescaping. Stored Greenhouse descriptions kept literal `<p>` tags, and "8+&nbsp;years" never read as a number. Escaped markup is now unescaped first, and numeric entities are decoded.
- **Boards moved off the browser extension**, so they run in GitHub Actions with the computer off. The Phenom career sites are front ends over Workday: their public `/widgets` search names each job's Workday apply link. That moved Fiserv, Truist, Southwest, Asurion (2 sites), Blue Yonder, Warner Bros. Discovery, Blizzard and Bose to Workday boards. AmEx (5 kept rows, all sponsorship YES, 1,321 approvals), Nokia and Navy Federal moved to `oracle_hcm`, whose API sits on an oraclecloud.com host behind the vanity domain. Aliases `fiserv`, `bose` and `warner-bros-discovery` were added to `EMPLOYER_ALIASES` so those boards resolve under their brand names. The extension's `STARTER_BOARDS` is now just what a server can't read: Tesla and Wayfair (they block automated clients), Yelp (iCIMS), Corning (no apply link in its API) and AutoZone (its tech roles sit past the 500 newest postings `oracle_hcm` reads).
- **Workday dates.** `parsePostedOn` read only "Posted N Days Ago", so "Posted Today", "Posted Yesterday" and "Posted 30+ Days Ago" arrived undated and were dated by the first run that saw them. A posting open for months showed as new, was deleted when that date left the 14-day window, then showed as new again on the next run. "30+" is now dated 30 days back, so retention drops it. On 2026-11-23, 48 of the 139 visible Workday rows were undated.
- **Separate openings get separate rows** (owner's call). The company|title|location key also merged *different* openings that share a title and location, so Palo Alto Networks' 20 headquarters "Software Engineer" reqs showed as one. When one direct source lists several openings under a key, `dedupeBatch` (`src/services/dedupe.js`) now keeps each, keyed `<key>#<opening>`. Two rows are one opening if they share the source's posting id or the link, so a req posted on two of an employer's Workday sites stays one row. Aggregators (`AGGREGATORS`) keep collapsing, because Getro tags one job with a different id in each VC network. An aggregator's copy joins the opening it links to, and an unmatched copy is dropped. `upsertJob` (both backends) now matches `apply_url` before `dedupe_key`. Matching the key first let an opening whose group had shrunk back to the plain key overwrite another opening's row. `/admin/ingest` now runs `dedupeBatch` too.
- 7 security / networking boards found by `probe-boards.js names`: Gen Digital, Extreme Networks, Cribl, Coalition, Ping Identity, KnowBe4 and BeyondTrust (end of `COMPANIES`). Probed and not added: Teleport, Keeper Security, Dragos and Cato Networks (0-1 H-1B approvals). Workday tenants weren't probed because Workday was rate-limiting the machine (HTTP 429). F5, Fortinet and Akamai came in with the coverage audit below. Dell, HPE, Proofpoint, Synopsys, DocuSign, Seagate, CyberArk, Rapid7, Trellix, Nutanix and American Express (Oracle HCM) are still to check. AMD posts on a Jibe site no collector reads.
- **Coverage audit** (owner's ask: don't miss employers with jobs). Against the FY2025–26 USCIS data, 341 of the 449 sponsors with 200+ approvals had no board. That count is inflated by scraper-covered employers (Google, Meta), name mismatches (JPMorgan, USAA), universities, hospitals and staffing firms. The new-grad lists are the better yardstick. `scripts/mine-lists.js` reads SimplifyJobs, vanshb03, speedyapply SWE + AI, three Zapply 2027 lists and jobright-ai's SWE list: 3,285 US software postings from 1,014 employers, 802 with no board. Of the 197 with 3+ H-1B approvals, it built boards from their apply links and verified each non-Workday one through its collector. It added 96, at the end of `COMPANIES`: Walmart, Bank of America, Snap, Chewy, Fidelity, F5, Thermo Fisher and LexisNexis Risk on Workday (38 boards, taken from live posting links and unprobed); Texas Instruments, Fortinet, Akamai, Emerson and Honeywell Aerospace on Oracle HCM; Twitch, Veeva, Brillio, Lila Sciences, Addepar and others on Greenhouse / Ashby / Lever / SmartRecruiters / Workable. speedyapply's AI list is now an `mdtable` source too (69 kept rows from 48 employers). Afterwards the uncovered 100+ approval sponsors on the lists dropped from 56 to 37. Still open:
  - **TikTok and ByteDance**: 508 US software postings on the lists and 0 rows on the board. The list copies are too old by the time they're collected, and their career sites (lifeattiktok.com, jobs.bytedance.com) have no collector. Biggest single gap. A separate session is building collectors for both on its own branch (cut from `main`).
  - **Workday tenants known only by name** (site unknown): Caterpillar (`cat`), Verizon (`verizon`), TD Bank (`td`), Wex (`wexinc`). Run `probe-boards.js names` once Workday isn't rate-limiting.
  - **No server-side collector**: Atlassian and Bank OZK (iCIMS); Two Sigma (Avature); Citadel, Citadel Securities, D. E. Shaw, Balyasny, C3 AI, Otter.ai, Carvana, Synopsys and Indeed (own sites); StubHub (EU Greenhouse). Candidates for the browser extension's "My boards". AMD, ICE, Rivian, DocuSign, First Citizens, Susquehanna, Viasat, Medpace and Keysight now come through the Jibe collector (next bullet). Costco is on Jibe too but lists no US software roles.
  - Not added on purpose: universities and hospitals, government, law firms, clearance-bound contractors (Leidos, Booz Allen, GDIT), xAI (excluded), PNC (refuses sponsorship). Dead on the day: `ashby:whatnot` (404), Boston Scientific's Eightfold (403).
  - briansjobsearch.com ("Brian's list") was rechecked. It is a `site:` search builder, not a list of employers, and its platform list already gave us the Workable / Recruitee / Pinpoint / Gem / BambooHR collectors (2026-10-31). Its remaining platforms (UKG / UltiPro, Paycom, ADP, Personio, Comeet, Freshteam, SuccessFactors, Taleo…) host only small sponsors in the new-grad lists, apart from SuccessFactors and Taleo. Those two serve large employers (SAP and others) as plain HTML and would need a scraping collector.
- **Jibe collector** (`src/collectors/jibe.js`). iCIMS Jibe career sites serve a public JSON search at `{baseUrl}/api/jobs`, with the full description in the list, so one collector reads them all with no per-job requests. Catalogues over 1,500 postings are searched by keyword. 9 employers are wired at the end of `COMPANIES`: AMD, Rivian, DocuSign, First Citizens, ICE, Keysight, Susquehanna, Viasat and Medpace. Dry run on the day: 26 kept rows, 14 of them sponsorship YES (Medpace 9). AMD's postings say "This role is not eligible for visa sponsorship", so its 11 rows read NO, which is correct.
- Gigs moved from Greenhouse to Ashby (`ashby:gigs`). Still failing every run: `ashby:fleetline` and `ashby:cedar` (404 on all three startup ATSes) and `workday:nxp-careers` (HTTP 422). All workflows run Node 22, matching `engines` and Vercel; they were on Node 20, which reached end-of-life in April 2026.

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
- Retention (updated 2026-10-31): the board **shows** jobs posted or first seen within `CONFIG.visibleDays` (default 7, `VISIBLE_DAYS`) and **deletes** them after `CONFIG.retentionDays` (default 14, `RETENTION_DAYS`) — owner's call. The gap stops a still-open undated posting being deleted and re-inserted as "new" every week. Duplicate links are collapsed at collect time (`canonicalUrl` + `dedupeBatch`) and cleaned from the DB by `src/scripts/dedupe-urls.js` (run in the backfill-derived workflow). Was: the DB only holds jobs whose `date_posted` (or, if null, `last_seen_at`) is within `CONFIG.retentionDays` (default 30). Enforced at normalize time (old dated rows rejected) and again at the end of each collect run via `pruneStaleJobs()` in [src/db/index.js](src/db/index.js). Tunable via the `RETENTION_DAYS` env var.
- First-seen date stamp: when a row arrives without a `date_posted` (Microsoft PCSX, Goldman GraphQL, Wipro, most Workday tenants, …), `upsertJob` stamps the current timestamp on first insert. Subsequent refetches hit the UPDATE branch where `date_posted = COALESCE(@date_posted, date_posted)` — so the stamped date is never overwritten. Combined with the retention sweep, this gives every row a meaningful "age" and null-dated retention fallback becomes a safety net rather than the common path. A one-shot backfill in `migrate()` copies `first_seen_at` into `date_posted` for any pre-existing null rows on next boot.
- `scripts/probe-yc-ats.js` — discovers YC companies that publish on Greenhouse/Lever/Ashby. Writes config-ready blocks to stdout; redirect into a file for the verifier.
- `scripts/verify-yc-ats.js` — verifies probe output before merge (Greenhouse exact-name match via `/boards/{slug}` metadata; Lever/Ashby via slug-variant provenance). 12 collisions caught on the first run (e.g. `greenhouse:beam` → "Bridge to Enter Advanced Mathematics" nonprofit, not YC Beam). 357 entries verified and merged into `src/config.js` on 2026-04-24.
- `scripts/probe-topstartups.js` — discovers non-YC curated startups (Anduril, ClickHouse, Chainguard, Harvey, Abridge, Semgrep, …) from topstartups.io. Scrapes the infinite-scroll page, filters US-HQ, reuses the same ATS probe + name-match verification as the YC flow. 277 entries merged.

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
2. **Entry-level OR mid-level (0-2 YOE), judged from the posting itself** (owner's call, 2026-11-23). Manager / director / VP / chief titles and internships are rejected outright. Senior / staff / lead / principal / architect / III+ titles stay only when the posting puts the role in range (a stated main requirement of at most 2 years, or a new-grad track). Everything else stays unless the posting asks for more than 2 years. `II` is mid-level. See `levelVerdict` in `normalize.js`.
3. **Role types:** SWE/SDE, MLE, AI/Research, Data Scientist, Data Engineer, DevOps/SRE/Platform, Security, Mobile
4. **Visa sponsorship tracking.** Classifier is rule-based (`src/services/classifier.js`). **With `AI_TAGGING=true` the collect cron also has MINA's qwen3:8b read each new or changed JD and overwrite role and sponsorship before saving (same columns; rule tags are the fallback). See `AI_TAGGING.md`.** Some sources pre-label sponsorship — their labels win over the classifier via `sponsorship_override`. **Roles a visa holder can't take are hidden by default** (owner's call, 2026-10-31): `deriveRestriction()` in `src/services/clearance.js` adds title rules (Cleared / TS/SCI / Federal / US Government…), explicit no-sponsorship (`NO_SPONSORSHIP`), and a defense/ITAR employer list applied only when a row has no description (`DEFENSE_EMPLOYER`). All stay in the DB; `?restriction=all` shows them. After changing these rules, run the `backfill-derived` workflow so existing Neon rows are reclassified.
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
| `src/services/dedupe.js` | In-batch dedupe helper (merges copies of one job; keeps separate openings apart) |
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
| `scripts/probe-yc-ats.js` | One-shot: discovers YC US-hiring companies on Greenhouse/Lever/Ashby and prints copy-paste-ready config entries to stdout. See §Tools & Scripts. |
| `scripts/verify-yc-ats.js` | Verifier: for each entry in a probe-output file, confirms the ATS board belongs to the claimed YC company. Greenhouse: exact-name match on `/boards/{slug}` metadata. Lever/Ashby: provenance (slug must be derivable from YC name or website). Writes `scripts/yc-ats-verified.txt` (config-ready) and `scripts/yc-ats-rejected.txt` (with reason). |
| `scripts/probe-topstartups.js` | topstartups.io-sourced company discovery with built-in verification. Paginates the infinite-scroll homepage, filters US-HQ, probes Greenhouse/Lever/Ashby. Writes `scripts/topstartups-ats-discovered.txt` and `scripts/topstartups-ats-rejected.txt`. |
| `scripts/probe-getro.js` | Resolves VC job-board hostnames → Getro `networkId` (from the board's `__NEXT_DATA__`), then verifies the search API returns US rows before emitting config lines. Takes hostnames as argv, otherwise walks a built-in candidate list. Boards on Consider rather than Getro are skipped automatically (no `__NEXT_DATA__`). |
| `scripts/probe-ats.js` | Same idea as the SmartRecruiters probe, for Workable / Recruitee / Pinpoint / Gem / BambooHR, with the YC US-hiring list added as a second candidate source. `node scripts/probe-ats.js [topN] [platform,...]`. Slug helpers are shared via `scripts/ats-slugs.js`. |
| `scripts/probe-smartrecruiters.js` | Walks `src/data/h1b-sponsors.json` in descending USCIS-approval order and probes slug variants against the SmartRecruiters postings API, keeping only boards with US postings. `node scripts/probe-smartrecruiters.js [topN]` (default 400). Ordering by real approval counts is the point — it surfaces employers that both sponsor heavily *and* are reachable. Note it stops at the first slug variant that hits, which can be a vestigial board (it found `robertbosch`, 1 posting, before `BoschGroup`, 288) — sanity-check counts before merging. |

---

## Sources — per-source implementation status

All collectors return jobs in this common shape:
```
{ source, external_id, company_name, job_title, location,
  apply_url, description, date_posted, countries?,
  sponsorship_override?, entry_level_override?, mid_level_override? }
```

`countries` is for sources whose API reports each location's country on its
own (PCSX/Microsoft's trailing ISO code, Getro's geocoded `location_details`).
When present, `normalizeJob` keeps the row iff it contains `'US'` and skips the
string heuristic `looksUS()` — which can't tell India's "IN" from Indiana once
locations are joined into one string. Prefer it over adding markers to
`looksUS()` whenever the source has structured location data. `inUS()` in
normalize.js applies the same rule for collectors that gate detail requests.

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
| *(scraper)* `phenom` | Playwright | `scraper/src/targets/phenom.js` | Phenom People sites (Cisco + Cognizant). Loads the search page once, then pages the page's own `/widgets` refineSearch endpoint, US only, 100 at a time (~486 Cisco rows). Cognizant serves a Cloudflare challenge and is reported as a failure. |
| `amazon` | Single-tenant | `src/collectors/amazon.js` | `amazon.jobs/en/search.json`, 9 role queries, deduped by id |
| `uber` | Single-tenant | `src/collectors/uber.js` | Uber's public Oracle HCM job API (site `UberCareers`), US only, descriptions for software titles; apply links go to `jobs.uber.com`. The old `uber.com/api/loadSearchJobsResults` returns 404 since 2026-11. No level field, so level comes from title and description. |
| `microsoft` | Single-tenant | `src/collectors/microsoft.js` | `apply.careers.microsoft.com/api/pcsx/search`. 887 jobs. **Found via scraper's debug-urls.js** — replace endpoint if PCSX disappears |
| `netflix` | Single-tenant (Eightfold) | `src/collectors/netflix.js` | `explore.jobs.netflix.net/api/apply/v2/jobs`. L-level detection: L3=entry, L4=mid, L6+=reject |
| `ghlistings` | Curated GitHub JSON | `src/collectors/ghlistings.js` | Generic — URL per config entry. Currently wired to `vanshb03/New-Grad-2027` + `SimplifyJobs/New-Grad-Positions`. Pre-labeled sponsorship via `SPONSOR_MAP` |
| `hn_hiring` | HN Firebase + YC allowlist | `src/collectors/hn_hiring.js` | Walks last 2 "Who is hiring?" threads via `hacker-news.firebaseio.com`, parses `Company \| Role \| Location \| URL` headers, filters by the YC US-hiring allowlist fetched from `akshaybhalotia/yc_company_scraper` (see `src/collectors/yc_companies.js`). Only source with per-comment `time` → clean `date_posted`. Run `scripts/probe-yc-ats.js` to discover YC companies on Greenhouse/Lever/Ashby. |
| *(scraper)* `meta` | Playwright | `scraper/src/targets/meta.js` | DOM scraper on `metacareers.com/jobsearch` + detail pages under `/profile/job_details/*`. Last validated live run captured **26 raw rows** after query/team fan-out plus description-based seniority pruning. Not full pagination — breadth comes from multiple search views, then detail-page extraction. |
| *(scraper)* `apple` | Playwright | `scraper/src/targets/apple.js` | Matches `jobs.apple.com/api/*`. Currently captures 0 rows — API fires no job-list XHRs during our session (SPA is cookie-gated) |
| *(scraper)* `google` | Playwright | `scraper/src/targets/google.js` | DOM scraper on Google Careers search pages + job detail pages. Last validated live run captured **21 raw rows** after query fan-out, detail extraction, and description-based seniority pruning. No RPC decoding needed anymore. |

| `getro` | VC portfolio boards | `src/collectors/getro.js` | **Reports stale employer names.** Portfolio records keep a startup's pre-acquisition name while the posting has moved to the acquirer's ATS — 46 Adobe roles arrive as "Frame.io", 32 IBM roles as "Instana", 16 Salesforce roles as "Airkit", plus Yammer→Microsoft, OPOWER→Oracle, Tessian→Proofpoint, Neon→Databricks. The USCIS lookup misses every one, so they landed `UNKNOWN` despite employers with thousands of approvals. Fixed by `employerFromApplyUrl()`, which derives a second lookup key from the apply_url host (generic rule, no acquisition map) and passes it as `sponsor_company_fallbacks` — see `classifySponsorship`'s third parameter. `company_name` as displayed is deliberately left alone. Net effect on one run: sponsorship `YES` went from 24% to 40% of rows. |
| `getro` (transport) | — | `src/collectors/getro.js` | `POST api.getro.com/api/v2/collections/{networkId}/search/jobs`, unauthenticated. 16 VC networks configured (~63k US postings). Results are **newest-first by default** (no sort param is honoured) so the collector pages until `created_at` crosses `RETENTION_DAYS` — volume scales with posting rate, not board size. `hitsPerPage` is capped at 20 server-side. Rows carry a direct ATS apply URL, a real posting date, and a `seniority` label. Descriptions come from the board's SSR job page (`__NEXT_DATA__ … currentJob.description`); there is no public per-job API. Run `scripts/probe-getro.js` to resolve a board hostname → `networkId`. |
| `eightfold` | Eightfold AI | `src/collectors/eightfold.js` | Generic multi-tenant implementation of the `/api/apply/v2/jobs` endpoint; `netflix.js` is now a thin wrapper over it that adds Netflix's vanity host and L-level hook. **`num` is hard-capped at 10** — the old Netflix collector requested 100 and stepped `start` by 100, silently skipping 90% of the catalogue (19 rows out of 490 postings). Descriptions require the per-job endpoint. Eightfold **rate-limits by IP across all tenants at once**; keep the tenant list short and the request budget low. |
| `smartrecruiters` | SmartRecruiters | `src/collectors/smartrecruiters.js` | Documented public API, no key: `api.smartrecruiters.com/v1/companies/{slug}/postings`. Richest of the ATS sources — the list response already carries `releasedDate`, a structured location and an `experienceLevel`, so rows are fully classified without a detail fetch (detail is used only for description text). `country=us` filters server-side (Bosch 4,812 → 288); `function=engineering` is accepted but silently ignored. Slugs are case-insensitive but exact, with no search endpoint — use `scripts/probe-smartrecruiters.js`, which walks `src/data/h1b-sponsors.json` in descending USCIS-approval order. |
| `workable` / `recruitee` / `pinpoint` / `gem` / `bamboohr` | Per-company ATS feeds | `src/collectors/{workable,recruitee,pinpoint,gem,bamboohr}.js` | Added 2026-10-31 from briansjobsearch.com's platform list. All unauthenticated, one request per employer except BambooHR (list has no description → title pre-filter, then a capped detail call). Endpoints: `apply.workable.com/api/v1/widget/accounts/{slug}?details=true`, `{slug}.recruitee.com/api/offers/`, `{slug}.pinpointhq.com/postings.json` (no posting date → first-seen stamp), `api.gem.com/job_board/v0/{slug}/job_posts/`, `{slug}.bamboohr.com/careers/list` + `/careers/{id}/detail` (unknown tenant = 302). No company search on any of them — discover with `scripts/probe-ats.js` (H-1B sponsors + YC US-hiring list), and review name collisions before merging. **Dover was checked and skipped:** `app.dover.com/robots.txt` disallows `/api/`, and its job pages are a client-rendered shell over that API (no JSON-LD). |
| `jibe` | iCIMS Jibe career sites | `src/collectors/jibe.js` | Public JSON search on each employer's careers host: `{baseUrl}/api/jobs?page=N&limit=100&sortBy=posted_date&descending=true&internal=false[&keywords=…]`. List rows carry the full description, `country_code`, `posted_date` and `meta_data.canonical_url` (the public job page), so there are no per-job requests. Catalogues over 1,500 postings are searched by keyword (Costco lists ~19k, nearly all retail). Many iCIMS employers sit behind a Jibe front end: to check a careers host, request `/api/jobs?page=1&limit=1`. Added 2026-11-23. |

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
| ~~Cisco~~ / ~~Cognizant~~ | Cisco: every US opening via the `phenom` scraper target (and Workday). Cognizant: blocked by a Cloudflare challenge; no source. |
| Goldman Sachs | Workday CxS returns 422 anonymously under `goldmansachs.wd1`/`wd5` for `External`, `GS_External_Careers`, `Professional`, `Campus`, and the `goldman`/`gs` tenant aliases (2026-04-24). |
| ~~Deloitte~~ | Implemented as the `deloitte` Playwright target (SSR DOM scrape) — see Sources table above. |
| General Electric / Vernova / Aerospace | `ge.wd1/wd5` returns 422; `jobs.gevernova.com` and `jobs.geaerospace.com` are both DNS-unresolvable. Unknown backends. (GE HealthCare is implemented — see `gehealthcare` Workday entry.) |
| ~~Wipro~~ | Implemented via the `wipro` collector (SAP SuccessFactors endpoint at `careers.wipro.com/services/recruiting/v1/jobs`) — see Sources table above. |
| HCL America | `careers.hcltech.com` loads but exposes no public job-search JSON — just an OneTrust cookie banner + internal telemetry beacon. No job links on the homepage. `www.hcltech.com/careers` returns HTTP/2 protocol error; `careers.hcltech.com`, `jobs.hcltech.com`, `apply.hcltech.com` are all DNS-dark (2026-04-24). |
| Shopify | Career site is an in-house Shopify Next.js SPA (`shopify.com/careers/search`) — no public JSON API. Greenhouse/Lever/Ashby all 404; `shopify.wd1.myworkdayjobs.com/shopify_careers` returns 422 (2026-04-24). |
| Atlassian | Lever board `atlassian` exists but returns 0 postings (migrated off). Greenhouse 404 under every tried slug; Ashby 404; SmartRecruiters `atlassian`/`Atlassian` returns 0. Current destination ATS appears non-public (2026-04-24). |
| Tesla direct | `tesla.com/cua-api/apps/careers/state` returns 403. Re-checked 2026-10-31 with real headless Chromium: the careers page itself is Akamai "Access Denied" too, so a scraper target won't work either. Remaining routes: ghlistings (only 2 rows live on 2026-10-31) and the `adzuna` entry, which is inert until `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` secrets exist (free key from developer.adzuna.com). |
| Wayfair (2026-10-31) | The `wayfair` scraper target now gets 0 rows: `wayfair.com/careers` serves a PerimeterX bot challenge (HTTP 429 "Access to this page has been denied") even to headless Chromium. Their ATS is Avature (`wayfair.avature.net`, from stored apply URLs), but `/careers/SearchJobs` 404s to non-browser clients and `/careers/sitemap.xml` is empty. Workday/Greenhouse slugs 401/403/422; SmartRecruiters `Wayfair` is a vestigial board. No clean route today. |
| LinkedIn (as employer or as a board) | LinkedIn the company posts its jobs only on linkedin.com/jobs (careers.linkedin.com just links there), so it falls under the LinkedIn row above. |
| briansjobsearch.com | Not a job source. It has no listings or API — it builds `"<title>" site:greenhouse.io` style queries and opens Google/Bing in a new tab. Scraping search-engine results is out (Google ToS + bot protection). What *is* useful is its ATS platform list: the ones we don't cover yet that publish per-company JSON are Workable, Recruitee, Pinpoint, Gem, BambooHR and Dover. Company discovery for those would follow `scripts/probe-smartrecruiters.js` (walk `h1b-sponsors.json`, probe slugs). |
| startup.jobs | Cloudflare "Just a moment..." challenge on every endpoint (homepage, `/feed` RSS, `/api/v1/*`). Same bucket as LinkedIn/Indeed. Won't ship. |
| wellfound.com (AngelList) | robots.txt explicitly disallows `/_jobs/`, `*?jobId=*`, `*?jobSlug=*`, `/job_listings/*`, `/job_profiles/embed`, `/jobs/applications`. Legal/ToS red line. Won't ship. |
| thehub.io | Nordic/Danish focus; effectively zero US rows after `FILTER_US=true`. Not worth implementation effort. |
| theantijobboard.com | Not actually a jobs site — landing page for an email newsletter. No scrapeable listings. |
| builtin.com | robots permissive, sitemap published, but content Cloudflare-gated and US-tech startup coverage overlaps heavily with Greenhouse/Lever/Ashby via the YC + topstartups probes. Duplicate yield not worth the effort. |
| topstartups.io (as a job collector) | Not a job board — company directory whose "View Jobs" links jump to per-company Notion/career pages. Instead used as a **company-discovery source** via `scripts/probe-topstartups.js`. |
| iCIMS | **robots.txt `Disallow: /`.** Checked 2026-08-13 on `careers-charter.icims.com`, the one tenant of 22 probed that resolved at all — blanket disallow for every user-agent. Same red line as wellfound.com. Separately, tenant hostnames are unguessable (1 hit in 22) and pages carry no JSON-LD, so even if robots allowed it there'd be no clean route. Won't ship. |
| Phenom (as a *generic* multi-tenant collector) | The `pcsx` collector already covers the one tenant whose `/api/pcsx/search` endpoint is actually public (Qualcomm). Probed 12 more large-sponsor career hosts on 2026-08-13 — `careers.cisco.com` returns HTML rather than JSON, the rest 404. Host patterns are not derivable from the company name, so a generic collector would have exactly one user. Cisco/Cognizant stay on the bounded `phenom` Playwright target. |
| Consider.com VC boards (a16z, Sequoia, Greylock, BVP, Founders Fund, First Round, CRV, Battery, Felicis) | Not Getro — a separate platform with no `__NEXT_DATA__` blob, so `scripts/probe-getro.js` correctly skips them. A Consider collector would be a second implementation for the same *kind* of source; worth doing only after the 16 Getro networks are proven insufficient. |
| Bayer (Eightfold) | Reachable and a real sponsor (147 approvals), but 626 postings contained **one** software title. ~63 requests per run for ~1 row, against a shared IP rate limit that also protects Netflix. Probed and rejected — don't re-add. |
| Visa (SmartRecruiters) | Supersedes the "no confirmed endpoint" note above: Visa *does* have a SmartRecruiters board, but it holds 1–2 US postings, so it isn't where they actually hire. Their real ATS remains unidentified. |

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
ORDER BY COALESCE(date_posted, first_seen_at) DESC,
         first_seen_at DESC,
         id DESC
```
i.e. newest first, with an undated row (Tesla, most extension captures) placed
by when the board first saw it, the date the page shows as "Seen …". Until
2026-11-24 undated rows sank below every dated one, so 139 Tesla jobs found
that morning sat at the end of the list.

---

## UI notes (`web/`)

**Defaults (owner's call, 2026-10-31):** sponsorship = YES ("Sponsors visas
(confirmed)"; `ANY` in the URL turns it off), restriction = hide, view =
grouped by company. The grouped view reads `GET /companies` (one row per
company with role count and newest date; a single-role company carries its
`job` inline) and expands a company with `GET /jobs?company=<name>`. Both
routes share `parseFilters()` in server.js and `buildWhere()` in each DB
backend, so the two views can't disagree about which rows a filter admits.
`?view=list` gives the old flat table.

**Excluded employers:** Netflix, xAI and Capgemini are hidden from every
source via `EXCLUDED_EMPLOYERS` in `src/services/clearance.js`
(`restriction = EXCLUDED_EMPLOYER`). Their collector entries were removed from
`COMPANIES`. Add to that list rather than deleting rows.

**Browser extension daily run:** `extension/` opens the saved boards once a
day (default 10:00 local; if the machine was off, on the first Chrome start
after that), in an unfocused window that closes itself ~45 s after the last
board loads. Logic in `extension/schedule.js` (tested). It only opens the
user's own list — max 25 boards, one visit each — and never clicks or pages.

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
The React code is framework-agnostic: it would drop into a Next.js app as-is
(TanStack Query runs identically there) if that is ever wanted.

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
11. Compute `dedupe_key = lower(company)|lower(title)|lower(location)` (slugified). `dedupeBatch` later appends `#<opening>` when one direct source lists several openings under it.

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

## Configuration (env vars and secrets)

Moved here from HOSTING.md (deleted 2026-11-24).

| Name             | Where                              | Value                                             |
|------------------|------------------------------------|---------------------------------------------------|
| `DATABASE_URL`   | Vercel env + GitHub Actions secret | Neon connection string (use the pooled one)       |
| `COLLECT_TOKEN`  | Vercel env + GitHub Actions secret | Random 32-byte hex, gates `/admin/*` routes       |
| `INGEST_URL`     | GitHub Actions secret (scraper)    | `https://<vercel-domain>/admin/ingest`            |
| `FILTER_US`      | Vercel env + Actions env           | `true`                                            |
| `FILTER_SOFTWARE`| Vercel env + Actions env           | `true`                                            |
| `ENTRY_LEVEL_MODE`| Vercel env + Actions env          | `permissive` (see `src/config.js`)                |
| `RETENTION_DAYS` | Vercel env + Actions env           | default `14` (drops rows older than N days at collect end)|
| `VISIBLE_DAYS`   | Vercel env + Actions env           | default `7` (how far back the board shows postings)|

**Do not** commit any of these. Vercel has an env-var UI; GitHub Actions has
repo Settings → Secrets and variables → Actions.

### Accounts and autofill (the Rust `/api` function)

All **Vercel only**, marked Sensitive. Never put `DATA_KEYS` or the R2 keys in
GitHub Actions: Actions also holds `DATABASE_URL`, and the two together would
decrypt everything. Give preview deployments their own values (a Neon branch,
their own `DATA_KEYS` and bucket).

| Name                 | Value |
|----------------------|-------|
| `GOOGLE_CLIENT_ID`   | OAuth client id (Google Cloud → Credentials → Web client). Authorized JavaScript origins: the Vercel URL and `http://localhost:5173`. |
| `DATA_KEYS`          | `1:<base64 of 32 random bytes>` (`openssl rand -base64 32`). To rotate, add `2:<new key>`; old values stay readable and are re-encrypted on their next write. Losing every key loses every profile and answer. |
| `DATA_KEY_CURRENT`   | Optional: the key version new writes use (default: the highest). |
| `STORAGE_DRIVER`     | `r2` (Cloudflare R2) or `s3` (Backblaze B2 or another S3-compatible service) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | With `STORAGE_DRIVER=r2`: a **private** R2 bucket and an API token scoped to that bucket only (Object Read & Write). R2 needs a card on file, even on the free tier. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | With `STORAGE_DRIVER=s3`: any S3-compatible **private** bucket. Backblaze B2 (10 GB free, no card): endpoint `https://s3.<region>.backblazeb2.com`, region like `us-west-004` (both shown on the bucket page), and an application key limited to that bucket with Read and Write. |
| `SIGNUPS_OPEN`       | `false` at launch. `true` lets anyone create an account (publish the privacy page first). |
| `SIGNUP_ALLOWLIST`   | Comma-separated Google `sub` ids that may sign up while sign-ups are closed (your own). Find yours in the `users` table after one dev sign-in, or decode your Google ID token. |
| `OWNER_SUBS`         | Comma-separated Google `sub` ids that see the usage panel in Settings. |
| `MAX_USERS`          | Default `500`. |
| `CRON_SECRET`        | At least 16 random characters. Vercel Cron sends it to `/api/cron/cleanup` daily (see `vercel.json`). |
| `INGEST_URL`, `COLLECT_TOKEN` | Also on the Rust function, for "Share job listings I browse": `INGEST_URL=https://<site>/admin/ingest` and the same `COLLECT_TOKEN` the Node backend checks. Users never see the token; their extension token is checked, listings are filtered and capped, then forwarded server to server. Without both, sharing answers 503. |
| `SHARING_OPEN`       | Default on. `false` turns listing sharing off for everyone. |
| `SHARES_PER_USER_PER_DAY` | Default `3000` listings per user per day. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | The bot from @BotFather, its @name (no @), and 16+ characters of A–Z a–z 0–9 _ - given to `setWebhook` as `secret_token`. Without the secret the webhook answers 404; without the token no alerts are sent. `CRON_SECRET` must also be in GitHub Actions secrets: the collect workflow uses it to call `/api/cron/alerts`. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | The Gmail connector's OAuth **Web application** client, in its own Google Cloud project (see "Gmail setup" above). Without both, Connectors shows Gmail as not set up. Optional `GMAIL_REDIRECT_URI` (default `$SITE_URL/api/connectors/gmail/callback`, must be registered on the client). |
| `SITE_URL`           | Default `https://job-two-xi.vercel.app`: the address links in chat messages point to. |
| Optional limits      | `MAX_RESUMES` (10), `MAX_USER_BYTES` (12 MB), `UPLOADS_PER_DAY` (5), `UPLOADS_PER_MONTH` (3000, all users), `R2_MAX_BYTES` (9 GB, all users), `SIGNINS_PER_IP_PER_DAY` (40). |

Without `DATA_KEYS`, R2 or `GOOGLE_CLIENT_ID`, the matching account routes
answer 503 and the public board keeps working. `GET /api/health` reports which
pieces are configured.

Neon's free plan is 1 GB (not 0.5 GB as written above) and 100 compute-hours a
month shared with the collector. Anonymous visitors never touch the accounts
tables: the web app calls `/api/auth/me` only when the `jb_li` cookie is set.

### Outside scheduler (collect and scrape every 3 hours)

GitHub's cron is unreliable for this repo: runs came 3.5–9 hours apart, and on
2026-11-24 nothing fired for 14 hours, with GitHub reporting no incident. A
free outside cron triggers the workflows instead; GitHub's schedule stays as a
backup, and the due check makes extra triggers harmless.

1. GitHub → Settings → Developer settings → Fine-grained tokens → new token:
   repository access *Only this repository*, permission *Actions: Read and
   write*, nothing else, longest expiry.
2. cron-job.org (free) → two cron jobs, every 30 minutes (collect at :11 and
   :41, scrape at :26 and :56):
   - URL `https://api.github.com/repos/SomyaPadhy4501/Job/actions/workflows/collect.yml/dispatches`
     (and `scrape.yml/dispatches`), method POST
   - headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`
   - body `{"ref":"main","inputs":{"gated":"true"}}`
   - success is HTTP 204.

`gated` makes the run check `.github/scripts/due.sh` first, like a scheduled
run: it does the work only when the last real run is 170+ minutes old (or
failed 55+ minutes ago). A run without it (the Actions button) always works.

### Hosting red lines (don't)

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

## Tools & Scripts

| File | What it does |
|---|---|
| `scripts/probe-yc-ats.js` | YC-company ATS discovery tool (see recipe above). Output shape: `{ source, slug, displayName }` blocks grouped by ATS. |
| `scripts/mine-lists.js` | Coverage audit from the community new-grad lists (Simplify, vanshb03, speedyapply, Zapply, jobright-ai). Ranks employers no board covers by H-1B approvals, prints config entries built from their apply links (non-Workday ones verified through the collector), Workday tenants known only by name, and employers on platforms with no collector. Re-run monthly: `node scripts/mine-lists.js --fresh`. |
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
- `RETENTION_DAYS` — delete jobs older than N days (default: `14`)
- `VISIBLE_DAYS` — only show jobs from the last N days (default: `7`)
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
- **Dedupe by company|title|location, not by external_id — with `apply_url` as the other key.** Same role from multiple sources (e.g. Nvidia appears in both Workday and ghlistings) merges into one row. The canonical key collapses cosmetic drift (strips `Inc/LLC/Corp`, parenthetical title modifiers like `(Remote)`, and trailing country codes from location). When two sources publish the same apply URL under slightly different metadata, `upsertJob` matches on `apply_url` (checked before the key since 2026-11-23) and merges them. **Exception (owner's call, 2026-11-23):** separate openings that one direct source lists under the same key keep separate rows (`<key>#<opening>`; see `dedupe.js`).
- **`II` is mid-level, not senior.** At most companies it means 1-3 YOE. Matches Somya's target range.
- **YC coverage is dual-path, not single-source.** `hn_hiring` gets the dated-but-narrow feed (HN "Who is hiring?" filtered to US YC companies); the ATS probe tool expands the main collector list to include many more YC companies directly from Greenhouse/Lever/Ashby. workatastartup.com is not usable (no public API). Don't re-investigate.
- **HN "Who is hiring?" comment parsing drops most rows deliberately.** From ~670 top-level comments/month we keep ~15–20 after: (a) YC allowlist filter, (b) "Company | Role | Location | URL" header format requirement, (c) role-keyword requirement (no generic "Engineer" fallback — would false-match sales/BD "Engineers"), (d) foreign-location early reject. Low yield is a feature, not a bug.
- **Cache is manually cleared on writes.** `src/api/cache.js` is not event-driven; any new mutation endpoint must call `jobsCache.clear()` explicitly.

---

## Known issues (not blockers, just context)

- **Same-title openings are indistinguishable in the list.** Separate openings now get separate rows, but they share company, title and location, so the list view shows them as identical lines until opened. The grouped view (the default) counts them under one company.
- **Collectors on Node 26 locally.** This machine runs Node 26, outside `engines` (22.x). `better-sqlite3` has no binary for it (the six SQLite tests fail locally; CI is unaffected), and Node 26's `fetch` can crash a run with an unhandled HTTP/2 `ECONNRESET`. Use Node 22 for local collects.

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

`npm test` runs the suite in `test/` (Node's built-in runner, 164 tests on
2026-11-23), and CI runs it on every push. Live verification still matters for
collector changes. To verify one:

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

## Rust backend: accounts, resumes and autofill (`crates/`, `api/server.rs`)

Everything under `/api/*` is one Rust function (axum on Vercel's Rust
runtime); `/jobs`, `/companies`, `/stats` and `/admin/*` are still the Node
function. Plan and design review: `~/.claude/plans/quiet-baking-duckling.md`.

- `crates/accounts`: no HTTP or SQL. Field encryption (AES-256-GCM bound to
  table, column, owner and key version; JSON deflated first), tokens, Google
  ID-token checks, the profile schema and its merge-by-source rules, tags,
  upload checks, the rule-based resume parser, resume ranking, R2/folder storage.
- `crates/db`: every query for the `migrations/004_accounts.sql` tables, each
  scoped to the owning user.
- `crates/api`: the Router. `auth` (Google sign-in with a nonce, `__Host-jb_sid`
  sessions: 30 days rolling, 90 days absolute, re-auth for tokens/export/delete),
  `resumes`, `profile` (versioned, 409 on a stale write), `answers`, `account`
  (tokens, export, delete), `autofill` (bearer token, for the extension),
  `housekeeping` (daily cleanup, owner usage). CSRF: writes need
  `X-Requested-With: fetch`, a same-site `Sec-Fetch-Site` and a matching `Origin`.
  Every response is `private, no-store`.
- Web pages: `web/src/pages/{Resumes,Profile,Settings,Privacy}.jsx`, a small
  router in `web/src/router.jsx`, the client in `web/src/account.js`.
- Extension autofill (JS) talks only to `/api/autofill/*`; see `extension/README.md`.

Run it locally (needs Docker Desktop; no Visual Studio tools on Windows):

```bash
docker compose run --rm cargo test --workspace   # all Rust tests, against the pg container
docker compose up api                            # dev API on :4100 (email-only dev sign-in)
cd web && npm run dev                            # http://localhost:5173, proxies /api to :4100
```

Production rollout: apply migration 004 (`migrate.yml`, verify then apply),
set the Vercel env in "Configuration (env vars and secrets)" → "Accounts and autofill" below, deploy a preview
first and check `GET /api/health` (Rust) and `/jobs` (Node) both answer, then
sign in, upload, edit the profile, create a token, export, and delete a test
account. Launch with `SIGNUPS_OPEN=false` and your own `sub` in `SIGNUP_ALLOWLIST`.

The Rust function now runs in production, and `form-schema` exists. Part C
(porting the Node backend to Rust) is dropped (owner's call, 2026-11-24).

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

---

## Don't (red lines)

- Don't re-try Indeed / Glassdoor / LinkedIn. Legal + ToS. The user has been told this.
- Don't globally set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Don't add features the user didn't ask for. They've been specific.
- Don't add interns. The user explicitly rejected them.
- Don't let senior titles through on the title alone. The level filter is load-bearing. Seniority words need evidence in the posting (`levelVerdict`), and that rule is general: don't add per-employer exceptions (owner's call, 2026-11-23).
- Don't write tests unless the user asks — they haven't.
- Don't delete `scraper/src/debug-urls.js`. It's a shipped diagnostic, not dev scaffolding.
- Don't try workatastartup.com again. No public API, endpoints 404 / gate on YC candidate session. `hn_hiring` + the ATS probe cover YC.
- Don't re-investigate startup.jobs, wellfound.com, builtin.com, thehub.io, or theantijobboard.com — see "intentionally not implemented" table for each site's specific blocker.
- Don't auto-paste raw `scripts/probe-yc-ats.js` output into `src/config.js` without running `verify-yc-ats.js` first. The raw probe uses loose slug variants (including bare domain stems) that false-match unrelated companies.
- Don't auto-paste `probe-topstartups.js` output either. Verification is already built into that probe, but review before merging — collisions the probe can't distinguish (e.g. two unrelated companies with the same name) still slip through.
- Don't re-sync main and scraper cron (`0 */2 *` and `30 */6 *`). The 30-min offset is intentional — prevents overlapping DB writes.
