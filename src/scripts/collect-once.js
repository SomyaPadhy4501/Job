'use strict';

// One-shot collection run. Useful for manual backfills or testing:
//   npm run collect                      every scheduled source
//   npm run collect -- --source jsearch  one source only — including the
//                                        `cadence: 'daily'` ones the 2-hourly
//                                        run skips (see SCHEDULED_COMPANIES)
const { COMPANIES } = require('../config');
const { collectAll } = require('../services/collect');

function sourceArg(argv) {
  const i = argv.indexOf('--source');
  if (i >= 0) return argv[i + 1] || null;
  const eq = argv.find((a) => a.startsWith('--source='));
  return eq ? eq.slice('--source='.length) : null;
}

(async () => {
  try {
    const source = sourceArg(process.argv.slice(2));
    const companies = source ? COMPANIES.filter((c) => c.source === source) : null;
    if (companies && !companies.length) {
      throw new Error(`no COMPANIES entries with source '${source}'`);
    }
    const result = await collectAll(companies ? { companies } : {});
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('collect failed:', err.message);
    process.exit(1);
  }
})();
