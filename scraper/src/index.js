'use strict';

const { start } = require('./scheduler');
const log = require('./logger');

start();

process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection', { error: err?.message || String(err) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: err?.message || String(err) });
});
