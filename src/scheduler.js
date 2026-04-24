'use strict';

const cron = require('node-cron');
const { CONFIG } = require('./config');
const { collectAll } = require('./services/collect');
const { jobsCache } = require('./api/cache');
const log = require('./logger');

let running = false;

async function runOnce(trigger) {
  if (running) {
    log.warn('scheduler.skip', { reason: 'already running', trigger });
    return;
  }
  running = true;
  try {
    const result = await collectAll();
    jobsCache.clear();
    log.info('scheduler.ok', { trigger, ...result });
  } catch (err) {
    log.error('scheduler.error', { trigger, error: err.message });
  } finally {
    running = false;
  }
}

function startScheduler() {
  if (!cron.validate(CONFIG.collectCron)) {
    throw new Error(`Invalid cron expression: ${CONFIG.collectCron}`);
  }

  const task = cron.schedule(CONFIG.collectCron, () => runOnce('cron'));
  log.info('scheduler.started', { cron: CONFIG.collectCron });

  if (CONFIG.runOnStart) {
    // Fire a first pass immediately; don't block startup.
    setImmediate(() => runOnce('startup'));
  }

  return { task, runOnce };
}

module.exports = { startScheduler, runOnce };
