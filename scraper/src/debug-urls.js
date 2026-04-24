'use strict';

// Diagnostic helper: open a target URL with Playwright and print every
// non-static response URL so we can see what API endpoints the page is
// actually calling. Usage:
//   node src/debug-urls.js https://apply.careers.microsoft.com/careers?query=software+engineer

const { newContext, closeBrowser } = require('./browser');
const { CONFIG } = require('./config');

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node src/debug-urls.js <url>'); process.exit(1); }
  const context = await newContext();
  const page = await context.newPage();
  const hits = new Map(); // url → { status, method, bytes, ct, hasJobs }

  page.on('response', async (res) => {
    const u = res.url();
    // Skip obvious static assets
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ico|webp|mp4)(\?|$)/i.test(u)) return;
    if (u.startsWith('data:')) return;
    const ct = res.headers()['content-type'] || '';
    let bytes = 0;
    let hasJobs = false;
    if (ct.includes('json')) {
      try {
        const j = await res.json();
        bytes = JSON.stringify(j).length;
        // Walk the tree to see if any array-of-objects has job-shaped items
        const walk = (o, d=0) => {
          if (d > 8 || !o) return false;
          if (Array.isArray(o) && o.length > 0 && typeof o[0] === 'object') {
            const sample = o[0] || {};
            const keys = Object.keys(sample).join(',').toLowerCase();
            if (keys.includes('title') || keys.includes('position') || keys.includes('jobid') || keys.includes('job_title')) return true;
          }
          if (typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) { if (walk(o[k], d+1)) return true; }
          return false;
        };
        hasJobs = walk(j);
      } catch {}
    }
    hits.set(u, { status: res.status(), method: res.request().method(), bytes, ct: ct.slice(0,40), hasJobs });
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(()=>{});
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(()=>{});
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    console.error('navigation error:', err.message);
  }

  console.log('\n=== Responses (non-static) ===');
  const sorted = [...hits.entries()].sort((a,b)=>b[1].bytes-a[1].bytes);
  for (const [url, meta] of sorted) {
    const star = meta.hasJobs ? ' ★ JOBS' : '';
    console.log(`${meta.method.padEnd(4)} ${meta.status} ${String(meta.bytes).padStart(7)}B  ${meta.ct.padEnd(20)} ${url}${star}`);
  }

  await page.close();
  await closeBrowser();
  setTimeout(() => process.exit(0), 500);
})();
