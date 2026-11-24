'use strict';

// One-shot collection run. Useful for manual backfills or testing:
//   npm run collect                      every scheduled source
//   npm run collect -- --source jsearch  one source only, including the
//                                        `cadence: 'daily'` ones the regular
//                                        run skips (see SCHEDULED_COMPANIES)
// GitHub Actions sets REQUIRE_DATABASE_URL=1: without DATABASE_URL the run
// would quietly write to a throwaway SQLite file on the runner and report
// success while nothing reached the real database.
const { COMPANIES } = require('../config');
const { collectAll } = require('../services/collect');

function sourceArg(argv) {
  const i = argv.indexOf('--source');
  if (i >= 0) return argv[i + 1] || null;
  const eq = argv.find((a) => a.startsWith('--source='));
  return eq ? eq.slice('--source='.length) : null;
}

if (process.env.REQUIRE_DATABASE_URL === '1' && !process.env.DATABASE_URL) {
  console.error('collect failed: DATABASE_URL is not set (check the repository secret).');
  process.exit(1);
}

// A run where no company answered (network down, every source blocked) is a
// failure, not an empty success.
function failureOf(result) {
  if (result.companiesOk === 0) return 'no company could be fetched';
  return null;
}

(async () => {
  try {
    const source = sourceArg(process.argv.slice(2));
    const companies = source ? COMPANIES.filter((c) => c.source === source) : null;
    if (companies && !companies.length) throw new Error(`no COMPANIES entries with source '${source}'`);
    const result = await collectAll(companies ? { companies } : {});
    console.log(JSON.stringify({ ...result, errors: result.errors?.length ?? 0 }, null, 2));
    const failure = failureOf(result);
    if (failure) {
      console.error(`collect failed: ${failure}`);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('collect failed:', err.message);
    process.exit(1);
  }
})();
