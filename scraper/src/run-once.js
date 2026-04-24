'use strict';

// One-shot scrape of all configured targets. Useful for testing + manual runs.
//   node src/run-once.js
const { runAll } = require('./run');
const { closeBrowser } = require('./browser');

(async () => {
  try {
    const results = await runAll();
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error('run-once failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
    // Playwright keeps IO handles; force exit after a short grace window.
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
