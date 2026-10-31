# Job Board Capture (personal Chrome extension)

Sends the job listings a careers page loads to this job board, for employers
whose sites block automated collection (Tesla, Wayfair) or that we haven't
wired a collector for yet. Generic: no per-company code. It recognizes job
lists by shape in the JSON the page fetches, plus schema.org `JobPosting`
data embedded in the page.

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

## What it does and doesn't see

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
and 11 more) and Jibe (Rivian). The starter board list in `background.js` is
those boards. **Tesla and Wayfair are untested**, because both block every
automated client, including the one used for these tests. If the badge shows
nothing on Tesla, the response shape needs a small adapter in `extract.js`.

Not yet supported: Apple (listings render without a JSON payload), SAP
SuccessFactors and Taleo boards (plain HTML), IBM.

## Daily run

At 10:00 (configurable), or on the first Chrome start after it if the
computer was off, the extension opens "My boards" once in a background window
— one tab every 4 s, max 25 — and closes the window about a minute after the last one.
Chrome has to be running for this; on a Mac, add Chrome to System Settings →
General → Login Items so it starts with the machine.

## Privacy

The token sits in `chrome.storage.local`. Fine for an unpublished personal
extension; don't share the folder with your settings in it.
