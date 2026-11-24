'use strict';

// One-shot collection run. Useful for manual backfills or testing:
//   npm run collect
// GitHub Actions sets REQUIRE_DATABASE_URL=1: without DATABASE_URL the run
// would quietly write to a throwaway SQLite file on the runner and report
// success while nothing reached the real database.
const { collectAll } = require('../services/collect');

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
    const result = await collectAll();
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
