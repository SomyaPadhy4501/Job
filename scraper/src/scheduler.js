'use strict';

const cron = require('node-cron');
const { CONFIG } = require('./config');
const { runAll } = require('./run');
const { closeBrowser } = require('./browser');
const log = require('./logger');

let running = false;

async function tick(trigger) {
  if (running) { log.warn('scheduler.skip', { reason: 'already running', trigger }); return; }
  running = true;
  try {
    await runAll();
  } catch (err) {
    log.error('scheduler.error', { trigger, error: err.message });
  } finally {
    // Drop the browser between runs so memory doesn't accumulate.
    await closeBrowser().catch(() => {});
    running = false;
  }
}

function start() {
  if (!cron.validate(CONFIG.cron)) throw new Error(`Invalid cron expression: ${CONFIG.cron}`);
  cron.schedule(CONFIG.cron, () => tick('cron'));
  log.info('scheduler.started', { cron: CONFIG.cron });
  if (CONFIG.runOnStart) setImmediate(() => tick('startup'));
}

module.exports = { start };
