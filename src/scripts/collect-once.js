'use strict';

// One-shot collection run. Useful for manual backfills or testing:
//   npm run collect
const { collectAll } = require('../services/collect');

(async () => {
  try {
    const result = await collectAll();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('collect failed:', err.message);
    process.exit(1);
  }
})();
