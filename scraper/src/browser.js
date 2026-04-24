'use strict';

const { chromium } = require('playwright');
const { CONFIG } = require('./config');
const log = require('./logger');

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  log.info('browser.launch', { headless: CONFIG.headless });
  browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  return browser;
}

async function newContext() {
  const b = await getBrowser();
  return b.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9',
    },
  });
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

module.exports = { getBrowser, newContext, closeBrowser };
