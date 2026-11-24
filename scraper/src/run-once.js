'use strict';

// One-shot scrape of all configured targets. Useful for testing + manual runs.
//   node src/run-once.js
const { runAll } = require('./run');
const { closeBrowser } = require('./browser');

(async () => {
  try {
    const results = await runAll();
    console.log(JSON.stringify(results, null, 2));
    // Every target failing (ingest down, browser broken) is a failed run, so
    // GitHub marks it red instead of green.
    const allFailed = results.length > 0 && results.every((r) => !r.ok);
    if (allFailed) console.error('run-once failed: every target failed');
    process.exitCode = allFailed ? 1 : 0;
  } catch (err) {
    console.error('run-once failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
    // Playwright keeps IO handles; force exit after a short grace window.
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
