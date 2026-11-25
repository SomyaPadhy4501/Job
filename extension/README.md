# Job Board Capture (personal Chrome extension)

Sends the job listings a careers page loads to this job board, for employers
whose sites block automated collection (Tesla, Wayfair) or that we haven't
wired a collector for yet. Generic: no per-company code. It recognizes job
lists by shape in the JSON the page fetches, plus schema.org `JobPosting`
data embedded in the page.

The extension can also fill the current application step on any job site
(Workday, Greenhouse, Lever, Ashby, iCIMS, Taleo, SuccessFactors, company
career sites, …) from your private profile, tagged resumes and saved answers,
sign you in or create the account with your one job-site login, and fill the
codes those sites email (see [Fill an application](#fill-an-application)). It
never submits an application.

**It only captures pages you open.** There is no background crawling by
design: the sites this exists for block automated traffic, and quietly
loading them from your browser on a timer would be exactly that. "Open my
boards" opens your saved list as ordinary tabs, like a bookmark folder.

## Install

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension icon, then fill in:
   - **Portal URL**: `https://job-two-xi.vercel.app`
   - **Autofill token**: from the site's Autofill page, then **Connect**.
   - **Share job listings I browse**: on, so captured listings reach the board.
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

Autofill works by itself on every job application (1.22.0). On Workday,
Greenhouse, Lever and Ashby, including forms embedded in an employer's own site
(Stripe, for one, shows Greenhouse inside its careers page; the button then
sits just above the form), it is there as soon as the page loads. Anywhere
else (iCIMS, Taleo, SuccessFactors, Oracle, SmartRecruiters, Tesla, Amazon,
company-built career sites) it appears once the page holds what looks like an
application: see "Other sites" below. A small tab with an arrow sits on the
right edge; click it to open the Autofill panel, and › to tuck it back.
**Autofill this page** in the side panel opens it on a form the tab missed.

### Set up

1. Sign in to the portal, open **Settings** and create an extension token.
   Copy it.
2. Open the extension popup, paste the token into **Autofill token** (the job
   board address is under **Job board address** if yours isn't the default)
   and click **Connect**. The token is bound to that exact origin. The popup
   then shows your email at the bottom. If it says "Token rejected", the token
   was revoked or mistyped: create a new one and connect again.
3. Optionally pick the **Resume** that breaks ties (the eye previews it).

The popup keeps only what filling needs: whether autofill is ready on the open
page, **Autofill this page**, and the resume. Sharing listings, the sites you
allowed and the owner's collection tools are behind the gear icon; Gmail
codes, the apply queue and the Workday login are managed on the job board.

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
   same question fills it from your answer bank, in the same wording or another
   ("Why are you interested in this role?" also answers "…this position?"), as
   long as every number, negation, technology and employer named is the same.
   An answer saved "only for" a company is used only there.

Employer-specific widgets, conditional legal names and location searches
without an exact selection can still need manual entry.

### Other sites (iCIMS, Taleo, SuccessFactors, Tesla, Amazon, company-built forms)

The tab shows up by itself once the page holds an application: a resume
upload, a work-authorization or EEO question, or your name and email together
with something only a job application has (job words in the address, title or
heading, a known application system's host, or LinkedIn, GitHub, salary,
education or work-history fields). A checkout or newsletter form with a name
and an email gets no tab. Until then the script only counts form controls
every 1.5 s at most, and shows nothing. Single-page sites that build the form
after you press Apply are noticed when it appears.

Pick the resume, click **Fill this page**, and review, exactly as above. If the
tab doesn't appear on an application, click **Autofill this page** in the side
panel. On a page opened before the 1.22.0 update, reload it (or the side panel
falls back to asking Chrome for that site, as before).

On these forms the extension finds the application form by itself (the form
with the most fields, preferring one with a resume upload) and ignores
newsletter, search and sign-in forms and the page header and footer. Fields
are matched by their label, then the `autocomplete` hint, then the placeholder.
Labels are read past wording around the field name ("Please enter your first
name", "What is your phone number?", "Mobile phone (include country code)",
"LinkedIn profile URL"), but never for someone else's details (a referrer, a
reference, an emergency contact, a previous employer) or a second value
("if different than above", "alternate email"). States and the US are matched
in either spelling (MA ↔ Massachusetts, United States ↔ USA), and a plain Yes
or No picks the one option that only restates it ("Yes, I am authorized to
work in the US"), never one that qualifies it ("Yes, but only for 12 months").
The same safety rules apply. Company-built forms vary a lot, so expect more
under **Needs you** than on the four ATSs, especially custom dropdowns and
multi-step flows (fill each step after it appears).

Autofill is not loaded on Gmail, Google Docs/Drive/Calendar, Google Search,
YouTube, GitHub, LinkedIn, Indeed, Glassdoor and `*.vercel.app` (the job board
itself).

### Education and jobs

School, degree, field of study, GPA and dates come from your profile's
education and experience only: the entry in progress or that ended last
answers questions like "School" or "Graduation date", and "Highest level of
education" uses your highest degree. Degree options are matched by level
(B.S. → "Bachelor's Degree"), schools and majors only by the same name. Month
and year boxes, MM/YYYY fields and month inputs are filled in their own format;
day pickers only if your profile date has a day. Nothing in the profile means
the field is left for you.

### Workday sign-in (Workday accounts)

Set one **Workday email and password** on the job board (Autofill page →
Workday accounts; stored encrypted on the server, never shown back). The
worker reads them with the autofill token (`GET /api/autofill/workday-login`)
only for the top frame of a Workday page; nothing is kept in the browser
(1.21.0 deletes the password older versions kept in the popup). On a Workday
sign-in page the extension chooses "Sign in with email", fills that email (or
your profile email if none is set) and the password, and presses Sign In
once you've interacted with the page. If that fails it offers Create account
or Forgot password and stops trying until you change the password on the job board. On
**Create Account** it fills email and both password boxes, ticks "I agree" and
presses Create Account; Workday's "verify your email" link is then opened from
Gmail (Alerts & Connectors). With a CAPTCHA on the form it fills the boxes and
leaves the rest to you.

### Sign-in and sign-up on other job sites

The same job-site email and password (the "Workday accounts" login above) also
signs in and creates accounts elsewhere (`autofill-account.js`, top frame
only):

- **Known application systems** (iCIMS, Taleo, SuccessFactors, Oracle,
  SmartRecruiters, Jobvite, Workable, Phenom, Avature, Eightfold, UKG, ADP,
  Dayforce and others listed in `application-pages.js`): on a sign-in form the
  email and password are filled and **Sign in** is pressed once, after you've
  interacted with the page; a failed sign-in stops automatic attempts there
  until the password changes. On a create-account form (two password boxes,
  or "create account" / "register" wording) the email, both passwords and your
  first and last name are filled, and a notice offers **Create account**,
  which presses the site's button when you click it.
- **Any other job site** (a company's own career site): a notice asks first;
  nothing is filled until you press **Fill** on it.
- It never ticks a terms or privacy box (a required one is outlined for you),
  never touches a CAPTCHA, never fills a field you already typed in, and asks
  the worker for the password at most 3 times per site per 10 minutes.

### Codes from Gmail

**Connect Gmail** on the job board, in Alerts & Connectors (read-only,
Google's consent screen; authorization-code flow with PKCE and OpenID Connect,
run by the server). The extension then fills the security / verification codes
job sites email at sign-up or mid-application, on any job site (1.22.0:
Workday, Greenhouse, iCIMS, Taleo, SuccessFactors, company career sites, …),
and opens a site's "verify your email" link. It finds a code box by its label,
`autocomplete="one-time-code"`, one box per digit (4–8 side by side), or a
single short box under "Enter the 6-digit code we sent you". It asks Gmail at
once, then every 1.5 s for 45 s and every 4 s after that, for up to 3 minutes,
and the portal stops at the first fitting email, so a code usually fills within
seconds of arriving. Only on job pages (a known application system, or an
address or title about jobs).

The worker asks the portal (`POST /api/autofill/gmail/code`, `/verify-link`,
with the autofill token); the portal reads only mail from that site from the
last 15 minutes and answers one code or one link. Which mail counts:

- Workday: `<company>@myworkday.com`; Greenhouse: its senders, naming this
  company.
- Any other site (`site: "other"`): only mail sent from the page's own
  application system (`icims.com` for an iCIMS page, …), naming the company
  when the page shows one, or from the employer's own domain on a
  company-hosted page (`tesla.com` for `www.tesla.com/careers`). Free mail
  domains never count. So a code from your bank, or from another site, can't
  land in a job site's form.
- Verify links must be https, on the page's own system or domain, with a
  verify / activate / confirm path, and never an unsubscribe, opt-out,
  preferences, withdraw, decline, delete, remove or cancel link.

The extension holds no Google token and needs no `identity` permission
(removed in 1.20.0). It still checks the answer: a code must have the shape the
page asked for, a link must pass the rules above. Never presses submit. The
portal needs `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` (see HANDOFF.md).

### Safety rules (enforced in code and covered by tests)

- **Never submits or navigates.** It never clicks a submit button, an implicit
  submit (a `<button>` in a form without `type="button"`), a link, or any
  control labelled Submit, Apply, Next, Continue, Review, Save, Back, Finish,
  Send, Sign in, Register, Create account, Remove or Delete, even when one is
  rendered as a dropdown option. The exceptions are sign-in pages: Workday's
  own sign-in panel (`autofill-login.js`, below) may press **Sign in with
  email** and **Sign In**, and on the create-account form tick Workday's own
  **I agree** and press **Create Account** once; on other known application
  systems `autofill-account.js` may press **Sign in** once. Both only after
  you've interacted with the page, never with a CAPTCHA on the form, never
  again after a failure until the password changes. Elsewhere, Create account
  is pressed only when you click it on the notice.
- **Never touches CAPTCHAs** (reCAPTCHA, hCaptcha, Turnstile) and never ticks
  a checkbox: consent, acknowledgement, privacy, attestation, signature,
  background-check and "share my data" controls are always left to you.
- **Only on your click**, and only into empty, visible, enabled fields. A
  value already on the form, typed by you or by the ATS, is never replaced.
  Password fields, and any form containing one, are never filled by the form
  filler; only the sign-in modules (`autofill-login.js` on Workday,
  `autofill-account.js` elsewhere) fill your job-site password there.
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

Autofill's isolated scripts (`application-pages.js`, `autofill-fields.js`,
`autofill-adapters.js`, `autofill.js`) and the code filler
(`autofill-codes.js`) run at document idle on every https page (1.22.0),
in all frames so embedded forms work; the sign-in module
(`autofill-account.js`) runs in the top frame of every https page but
Workday's (`autofill-login.js` has those). This needs no new permission: the
listing-capture scripts already match every page. Each script stays idle unless
the page is a job application, a job site's sign-in form or a code box. It has
no page-world script. The worker answers profile requests from any https tab,
never from plain http or another extension; the profile reaches the page only
after you click. Pages opened before an update, and the excluded sites, still
use the older route: `activeTab` and `scripting`, plus an optional host
permission that Chrome asks for one site at a time when you click **Autofill
this page**.

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

The extension no longer collects Workday employers (removed in 1.21.2). The
server reads them from GitHub Actions again: Workday's Cloudflare refused
Node's `fetch`, not the server, and `src/collectors/http.js` now sends Workday
requests through Node's `https` module. The hand-configured employers run with
every collect; the ~1,250 found by `scripts/discover-workday.js` run twice a
day (`workday-wide.yml`), and that list is refreshed monthly
(`discover-workday.yml`). Updating removes the old Workday settings and alarm.

Listings shared while browsing a Workday careers page still go through
`/api/capture/jobs` and are stored as source `workday`.

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
