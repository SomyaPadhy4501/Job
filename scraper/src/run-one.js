'use strict';

// Scrape a single target by slug:
//   node src/run-one.js microsoft
// Useful for debugging one site without running the whole batch.
const { runOneTarget } = require('./run');
const { closeBrowser } = require('./browser');

(async () => {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: node src/run-one.js <google|meta|apple|microsoft>');
    process.exit(1);
  }
  const result = await runOneTarget(slug);
  console.log(JSON.stringify(result, null, 2));
  await closeBrowser();
  setTimeout(() => process.exit(result.ok ? 0 : 2), 500);
})();
