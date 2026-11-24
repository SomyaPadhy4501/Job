# Job Board Capture (personal Chrome extension)

Sends the job listings a careers page loads to this job board, for employers
whose sites block automated collection (Tesla, Wayfair) or that we haven't
wired a collector for yet. Generic: no per-company code. It recognizes job
lists by shape in the JSON the page fetches, plus schema.org `JobPosting`
data embedded in the page.

The extension can also fill the current application step on Workday, Greenhouse,
Lever and Ashby from your private profile, tagged resumes and saved answers
(see [Fill an application](#fill-an-application)). It never submits.

**It only captures pages you open.** There is no background crawling by
design: the sites this exists for block automated traffic, and quietly
loading them from your browser on a timer would be exactly that. "Open my
boards" opens your saved list as ordinary tabs, like a bookmark folder.

## Install

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension icon, then fill in:
   - **Portal URL**: `https://job-two-xi.vercel.app`
   - **Collect token**: the `COLLECT_TOKEN` value set on Vercel / in GitHub secrets.
   - **My boards**: one careers URL per line, e.g.
     `https://www.tesla.com/careers/search/?country=US`
4. **Save**.

## Daily use

Click **Open my boards**, wait for the pages to load, close the tabs. The
badge on the icon shows how many jobs each page sent (red `!` = error; the
popup log says why). Rows land in the board under source `extension`, after
the same US / software / level / sponsorship / ITAR filters as every other
source.

## Fill an application

Autofill works by itself on Workday, Greenhouse, Lever and Ashby application
forms, including ones embedded in an employer's own site (Stripe, for one,
shows Greenhouse inside its careers page; the button then sits just above the
form). On any other site (Tesla, Amazon, company-built career sites), open
the application form and click **Autofill this page** in the popup; see
"Other sites" below.

### Set up

1. Sign in to the portal, open **Settings** and create an extension token.
   Copy it.
2. In the extension popup, set **Portal URL** to the same portal and click
   **Save**. The token is bound to that exact origin; changing the portal URL
   later disconnects it.
3. Under **Autofill**, paste the token into **Personal autofill token** and
   click **Connect**. The popup should say "Connected as" and your email. If
   it says "Token rejected", the token was revoked or mistyped: create a new
   one in Settings and connect again.
4. Optionally pick a **Default resume**. A collect token is not needed for
   autofill; it is only for listing capture.

The portal must be HTTPS (plain HTTP only on `localhost` / `127.0.0.1` for
development) and on a host listed in `host_permissions` (`*.vercel.app` and
loopback today; add a custom domain there if the portal moves).

### Use

1. On an application, click **Autofill** in the lower-right corner. Nothing is
   fetched or filled until you click. The resume picker puts the best match
   first: the portal ranks it when it supports `GET /api/autofill/resumes?title=`;
   otherwise resume tags are matched against the job title and page here, with
   your default breaking ties. Choose **Leave resume empty** to attach a file
   yourself.
2. Click **Fill this page** (Workday: **Fill this step**). The resume is
   attached first and the ATS's own resume parser gets a few seconds to
   settle; then the empty fields are filled. Afterwards every filled value is
   read back, and anything the form did not keep moves to **Needs you**.
   On a Lever form you already started, attach the resume yourself: Lever can
   parse a file back into the contact fields.
3. Review **Filled**, **Needs you** and **Skipped**. Filled sponsorship,
   work-authorization, visa and EEO answers are marked "check it". Required
   fields left empty get an orange outline.
4. On Workday, move to the next step yourself and click **Fill this step**
   again; the panel notices the new step and never carries a fill over.
5. Custom questions with no saved answer are listed under **Needs you**.
   Answer them on the form. After you submit, a small card lists the new
   answers (ticked by default) and asks whether to save them; only the ones
   you keep are sent (`POST /api/autofill/answers`). The next form asking the
   same question (same wording) fills it from your answer bank.

Employer-specific widgets, conditional legal names and location searches
without an exact selection can still need manual entry.

### Other sites (Tesla, Amazon, company-built forms)

1. Open the application form itself (sign in to the employer's site first if
   it asks).
2. Click the extension icon, then **Autofill this page**. Chrome asks once
   whether the extension may use that site; allow it. The Autofill panel opens
   on the form with the resume picker, and from then on the **Autofill** button
   appears on that site by itself.
3. If part of the page comes from another site (an embedded form), the popup
   offers **Also allow the embedded form (…)**.
4. Pick the resume, click **Fill this page**, and review, exactly as above.

On these forms the extension finds the application form by itself (the form
with the most fields, preferring one with a resume upload) and ignores
newsletter, search and sign-in forms and the page header and footer. Fields
are matched by their label, then the `autocomplete` hint, then the placeholder.
The same safety rules apply. Company-built forms vary a lot, so expect more
under **Needs you** than on the four ATSs, especially custom dropdowns and
multi-step flows (fill each step after it appears).

**Sites you allowed** in the popup lists them; **Remove** takes the permission
back (so does removing it in Chrome's extension settings).

### Education and jobs

School, degree, field of study, GPA and dates come from your profile's
education and experience only: the entry in progress or that ended last
answers questions like "School" or "Graduation date", and "Highest level of
education" uses your highest degree. Degree options are matched by level
(B.S. → "Bachelor's Degree"), schools and majors only by the same name. Month
and year boxes, MM/YYYY fields and month inputs are filled in their own format;
day pickers only if your profile date has a day. Nothing in the profile means
the field is left for you.

### Workday sign-in (job site password)

Set one **Job site password** in the popup (kept only in this browser's
extension storage). On a Workday sign-in page the extension chooses "Sign in
with email", fills your profile email and the password, and presses Sign In
once you've interacted with the page. If that fails it offers Create account
or Forgot password and stops trying until you change the password. On
**Create Account** it fills email and both password boxes; you tick "I agree"
and click Create Account.

### Codes from Gmail

**Connect Gmail** in the popup (read-only, Google's consent screen) and the
extension fills the security / verification codes Greenhouse and Workday
email mid-application, and opens Workday's "verify your account" link. It reads
only mail from those sites from the last 15 minutes and never presses submit.
Needs a Google OAuth client id in `config.js` (see HANDOFF.md).

### Safety rules (enforced in code and covered by tests)

- **Never submits or navigates.** It never clicks a submit button, an implicit
  submit (a `<button>` in a form without `type="button"`), a link, or any
  control labelled Submit, Apply, Next, Continue, Review, Save, Back, Finish,
  Send, Sign in, Register, Create account, Remove or Delete, even when one is
  rendered as a dropdown option. The one exception is Workday's own sign-in
  panel (`autofill-login.js`, below): it may press **Sign in with email** and
  **Sign In**, never **Create Account** or "I agree".
- **Never touches CAPTCHAs** (reCAPTCHA, hCaptcha, Turnstile) and never ticks
  a checkbox: consent, acknowledgement, privacy, attestation, signature,
  background-check and "share my data" controls are always left to you.
- **Only on your click**, and only into empty, visible, enabled fields. A
  value already on the form, typed by you or by the ATS, is never replaced.
  Password fields, and any form containing one, are never filled by the form
  filler; only the Workday sign-in module fills your job site password there.
  Bot-trap (honeypot) fields are never filled.
- **No guessing on immigration questions.** Sponsorship is filled only from
  your explicit "need sponsorship now" / "in the future" answers, matched to
  the question's timeframe ("now or in the future" needs both known unless one
  is Yes). "Are you legally authorized to work in the US?" uses only your
  explicit work-authorization answer, never citizenship or visa status. A
  blank (unknown) profile answer is never read as No. Negated, combined
  ("…and Canada", "without sponsorship"), non-US or otherwise ambiguous
  wording is always left blank, even with a saved answer.
- Qualification checks ("7+ years of…"), self-ratings, puzzles and essays fill
  only from a saved answer to the same question. EEO questions fill only from
  your explicit choices (including "decline").
- **Data goes only to your portal.** The service worker calls
  `<portal>/api/autofill/*` with `Authorization: Bearer <token>`, without
  cookies and refusing redirects. Employer pages never see the token, and an
  ATS tab can request profile data but cannot change the connection.

## What listing capture sees

- Activates only on URLs whose path contains `career`, `jobs` or `job/`, and on
  the job-system hosts (Workday, Ashby, Greenhouse, Lever, Workable,
  SmartRecruiters, Avature, Eightfold, Oracle, Taleo, SuccessFactors, iCIMS and
  others — see `manifest.json`). Nothing else you browse is inspected.
- Reads responses; never sends requests to the careers site itself.
- Jobs without a location are dropped, since the server would otherwise keep
  them as "maybe US".
- Sites that render jobs as plain HTML with no JSON or JSON-LD (Greenhouse's
  hosted boards, SmartRecruiters) give 0 rows. Those are covered by the
  server-side collectors anyway.

Verified on 2026-10-31 against Workday (NVIDIA), Eightfold, Workable, Amazon,
Ashby (813 rows from one page load), Oracle Candidate Experience (American
Express, Nokia, AutoZone, Navy Federal), Phenom (Chewy, Cigna, Truist, Fiserv
and 11 more) and Jibe (Rivian). Most of those boards now run server-side, in
GitHub Actions with the computer off (2026-11-23): the Phenom sites through
their Workday boards, AmEx, Nokia and Navy Federal through `oracle_hcm`, Rivian
through the Jibe collector. The starter list in `background.js` keeps only
what a server can't read: Tesla, Wayfair, Yelp, Corning and AutoZone. An
existing install keeps its saved boards; remove the moved ones in the popup.
**Tesla and Wayfair are untested**, because both block every
automated client, including the one used for these tests. If the badge shows
nothing on Tesla, the response shape needs a small adapter in `extract.js`.

Not yet supported: SAP
SuccessFactors and Taleo boards (plain HTML), IBM.

## Permissions and where it runs

The manifest matches every page, but a gate in `hook.js` / `content.js`
switches the scripts off immediately unless the host looks like a careers
site (`careers.`, `jobs.`, a known ATS) or the path mentions careers, jobs,
search results or openings. Chrome's match patterns can't express "host
starts with careers.", which is why this isn't done in the manifest.

Autofill's isolated scripts (`autofill-fields.js`, `autofill-adapters.js`,
`autofill.js`) run at document idle on the six ATS host patterns, in all frames
so embedded forms work. It has no page-world script. For other sites it uses
`activeTab` and `scripting`, plus an optional host permission that Chrome asks
for one site at a time when you click **Autofill this page** (the manifest's
`optional_host_permissions` only makes asking possible; nothing is granted at
install). A granted site gets a registered content script so the button
returns there, and the worker answers it only while the permission stands.

**Capture protections.** Listing capture must never pick up an applicant's own
data, so `application-pages.js` (and a copy of the same rules in `hook.js`,
which runs in the page world) marks private pages: any `/apply`,
`/application(s)`, `userHome`, `candidateHome`, `login` or `signin` path, every
Workday job, candidate or registration page, and on Greenhouse, Lever and Ashby
every page below the board itself (job pages embed the form). Then:

- `hook.js` never wraps `fetch` / `XMLHttpRequest` on a private page. On an ATS
  board page it forwards only that ATS's public listing endpoints (Workday
  `…/wday/cxs/…/jobs`, Ashby `ApiJobBoard*`, Lever `/v0/postings/…`, Greenhouse
  `/v1/boards/…/jobs`), and drops a response if the page moved to a private
  route while it was in flight.
- `content.js` does not start on a private page and re-checks the URL before
  sending. Without a collect token it makes no link-probe or description
  requests and forwards nothing.
- The worker ignores captured rows whose tab or page URL is private.

## LinkedIn, Indeed, Glassdoor

Off by default ("Capture LinkedIn / Indeed / Glassdoor pages I browse" in the
popup). Their terms ban automated collection and they restrict accounts for
it, so even when enabled the extension only reads job lists on pages you open
yourself: they can't be scheduled boards, and they never get link probes or
description requests.

## Scheduled run

Every 3 hours (configurable), or on the first check after the computer wakes
if a run was missed, the extension opens "My boards" in a background window —
one tab every 4 s, max 25. Each tab closes itself a few seconds after its jobs
are sent, and a 3-minute alarm closes anything left. For new jobs that will
plausibly be kept it also fetches the job's own page (≤ 25 per board per run,
1.2 s apart, 10 s timeout, never the same job twice) so the board can tag
years of experience and ITAR/clearance wording.
Chrome has to be running for this; on a Mac, add Chrome to System Settings →
General → Login Items so it starts with the machine.

## Workday employers (site owner)

Workday's Cloudflare answers the server collector's requests with HTTP 429
(since 2026-11-24), so the extension can read the Workday employers instead.
Turn on **Collect Workday employers from this computer** under Advanced (it
asks Chrome for access to `*.myworkdayjobs.com`), with the collect token set.

- Every 6 hours, in the background: no windows or tabs open.
- The employer list is `/downloads/workday-tenants.json`, built from
  `src/config.js` at each deploy, so new employers need no extension update.
- One request at a time, one a second, the same calls each careers site makes
  (`workday-collect.js`). A run of ~256 employers takes about an hour.
- Only US, technical postings from the last 14 days are sent, as source
  `workday` (the server filters them again). Descriptions are read for up to
  40 postings per employer, and never twice for the same posting.
- The first 429, 403 or block page ends the run until the next one, so your
  own Workday sign-ins aren't put at risk. The popup shows the last run.
- **Run Workday now** starts one immediately.

## Privacy

The collect token and portal settings live in `chrome.storage.local`. The
autofill bearer token is separate and bound to the configured portal origin
in extension-owned IndexedDB. **Disconnect** clears that credential and the
profile cache. Revoke the token in the portal to disable it on other devices.

The worker fetches the profile and resume and posts selected answers to
`/api/autofill/*` on your portal, over HTTPS (or HTTP on loopback for local
testing). Authenticated requests reject redirects. The worker reuses a profile
in `chrome.storage.session` for up to ten minutes. Resume bytes stay in memory.
Opening the panel retrieves the profile. Clicking **Fill** places selected data
in the employer's form, where the ATS can process it, including uploading or
parsing the attached file before submission. Autofill has no analytics endpoint.

## Verify locally

Run `npm ci` and `npm test` with Node 22. The linkedom fixtures exercise all
four adapters offline; `test/extension-autofill-api.test.js` checks the worker
against the `/api/autofill` contract, and `test/extension-capture-guard.test.js`
checks the capture protections. With the scraper's Playwright Chromium
installed, `node test/extension-autofill-live.cjs --live` (set
`PLAYWRIGHT_PACKAGE` to use another Playwright install) loads this folder
unpacked in a temporary headless profile and connects it to a loopback stub.
It uses public Greenhouse, Lever and Ashby postings plus a Workday fixture,
blocks page requests during fill, and checks the final form values, that no
submit event fired, and the answer-bank request. It never submits. Public
postings may close or change their questions.
