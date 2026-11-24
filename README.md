# US SWE Jobs

A free job board for new-grad and early-career US software jobs, with visa
sponsorship history from H-1B data, plus a Chrome extension that fills job
applications from your profile and resumes.

- Live: https://job-two-xi.vercel.app (on iPhone: Safari → Share → Add to Home Screen)
- `src/`, `scraper/`: job collectors (GitHub Actions, every 3 hours) and the public job API
- `crates/`: Rust API for accounts, resumes, profile and autofill
- `web/`: the website (React + Vite)
- `extension/`: the Chrome extension ([extension/README.md](extension/README.md))

Start with [HANDOFF.md](HANDOFF.md) for how everything fits together, how to
run it locally, and the configuration reference.
