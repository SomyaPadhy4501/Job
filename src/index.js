'use strict';

const { startApi } = require('./api/server');
const { startScheduler } = require('./scheduler');
const { getDb } = require('./db');
const log = require('./logger');

function main() {
  getDb(); // ensure schema exists before anything queries it
  startApi();
  startScheduler();

  process.on('unhandledRejection', (err) => {
    log.error('unhandledRejection', { error: err?.message || String(err) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { error: err?.message || String(err) });
  });
}

main();
