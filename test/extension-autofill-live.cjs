'use strict';

// Opt-in browser smoke test. Run this file with --live after installing the
// scraper's Playwright Chromium. The extension is loaded unchanged. Only fake
// profile data enters the forms, with all remote requests blocked during fill.
async function live() {
  const http = require('node:http');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '../scraper/node_modules/playwright');
  const profile = {
    user: { email: 'pat@example.invalid', name: 'Pat Example' },
    profile: {
      schema: 1,
      identity: { firstName: 'Pat', lastName: 'Example', preferredName: 'Pat' },
      contact: { email: 'pat@example.invalid', phone: '2025550100' },
      links: { linkedin: 'https://example.invalid/profile', github: 'https://example.invalid/code' },
      address: { city: 'Boston', state: 'MA', country: 'United States' },
      workAuth: { authorizedUS: true, requiresSponsorshipNow: false, requiresSponsorshipFuture: true },
      misc: { howDidYouHear: 'LinkedIn' },
    },
    answers: [],
    resumes: [
      {
        id: 'sample',
        title: 'Engineering sample',
        tags: ['Engineer'],
        isDefault: true,
        fileName: 'example.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      },
    ],
  };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.headers.authorization !== 'Bearer test-only') {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/api/autofill/profile')
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(profile));
    else if (req.url === '/api/autofill/resumes/sample/file')
      res
        .writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename="example.txt"',
        })
        .end('Example only');
    else if (req.url === '/api/autofill/answers' && req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      profile.answers = JSON.parse(body).answers;
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ saved: profile.answers.length }));
    } else res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let context;
  try {
    const dir = path.resolve(__dirname, '../extension');
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: ['--disable-extensions-except=' + dir, '--load-extension=' + dir],
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const popup = await context.newPage();
    await popup.goto(new URL('/popup.html', worker.url()).href);
    await popup.locator('#portalUrl').fill('http://127.0.0.1:' + server.address().port);
    await popup.locator('#autofillToken').fill('test-only');
    await popup.locator('#connect').click();
    await popup.getByText('Connected as pat@example.invalid').waitFor();
    for (const [site, url, ready] of [
      ['Greenhouse', 'https://job-boards.greenhouse.io/cloudflare/jobs/8097321', '#first_name'],
      [
        'Lever',
        'https://jobs.lever.co/palantir/ab7e3425-81d5-4705-a7b5-cd60c8a45cdb/apply',
        'input[name="name"]',
      ],
      ['Workday fixture', 'https://fixture.myworkdayjobs.com/Jobs/apply', '#first'],
      [
        'Ashby',
        'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application',
        '#_systemfield_name',
      ],
    ]) {
      const page = await context.newPage();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Runtime.enable');
        const errors = [];
        cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
          if (d.url?.startsWith('chrome-extension:')) errors.push(d.exception?.description || d.text);
        });
        if (site === 'Workday fixture') {
          await page.route('https://fixture.myworkdayjobs.com/**', (r) =>
            r.fulfill({
              contentType: 'text/html',
              body:
                '<form data-automation-id="jobApplicationPage"><h1 aria-current="step">Contact details</h1>' +
                '<label>First name<input id="first"></label><label>Email<input value="kept@example.invalid" id="kept"></label>' +
                '<label>Unknown required question<input required></label><button>Next</button></form>',
            })
          );
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator(ready).first().waitFor({ timeout: 45000 });
        await page.waitForTimeout(1200);
        await page.route('**/*', (route) => route.abort());
        await page.evaluate(() => {
          window.__smokeSubmits = 0;
          document.addEventListener(
            'submit',
            (e) => {
              window.__smokeSubmits++;
              e.preventDefault();
            },
            true
          );
        });
        const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        function shadows(n) {
          return [...(n.shadowRoots || []), ...(n.children || []).flatMap(shadows)];
        }
        const roots = shadows(root);
        let id;
        for (const node of roots) {
          const result = await cdp.send('DOM.querySelector', {
            nodeId: node.nodeId,
            selector: 'section[aria-label="Job application autofill"]',
          });
          if (result.nodeId) {
            id = node.nodeId;
            break;
          }
        }
        assert.ok(
          id,
          'Unpacked extension panel is present on ' + page.url() + ' (' + roots.length + ' shadow roots)'
        );
        const { object } = await cdp.send('DOM.resolveNode', { nodeId: id });
        const inPanel = async (fn, args = []) => {
          const r = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: fn.toString(),
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
          });
          if (r.exceptionDetails)
            throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          return r.result.value;
        };
        const click = async (selector, question = '') => {
          const point = await inPanel(
            function (s, q) {
              const el = [...this.querySelectorAll(s)].find(
                (node) => !q || node.closest('li')?.textContent.startsWith(q)
              );
              el.scrollIntoView({ block: 'nearest' });
              const r = el.getBoundingClientRect();
              return [r.x + r.width / 2, r.y + r.height / 2];
            },
            [selector, question]
          );
          await page.mouse.click(...point);
        };
        await click('button.main:last-child');
        for (
          let i = 0;
          i < 50 &&
          (await inPanel(function () {
            return this.querySelector('section button.main').disabled;
          }));
          i++
        )
          await page.waitForTimeout(100);
        await click('section button.main');
        for (
          let i = 0;
          i < 120 &&
          !(await inPanel(function () {
            return this.querySelector('section strong')?.textContent;
          }));
          i++
        )
          await page.waitForTimeout(100);
        const results = await inPanel(function () {
          return [...this.querySelectorAll('strong')].map((s) => [
            s.textContent,
            [...s.nextElementSibling.children].map((el) => el.textContent.slice(0, 220)),
          ]);
        });
        console.log(
          site,
          JSON.stringify(
            results.map(([group, items]) => [
              group,
              group.startsWith('Filled')
                ? items
                : items.filter((t) =>
                    /sponsor|resume|Visa|years of experience building software|Privacy Policy/i.test(t)
                  ),
            ])
          )
        );
        const value = await page.locator(ready).first().inputValue();
        assert.ok(value.startsWith('Pat'), site + ' name field');
        if (site === 'Greenhouse') {
          const sponsorship = page
            .locator('label')
            .filter({ hasText: 'require immigration sponsorship' })
            .first();
          const wrapper = sponsorship.locator('..');
          assert.equal(
            await wrapper.locator('.select__single-value,[class*="-singleValue"]').innerText(),
            'Yes'
          );
          assert.equal(await page.locator('.checkbox input:checked').count(), 0);
        }
        if (site === 'Lever') {
          assert.equal(
            await page.locator('input[name=resume]').evaluate((el) => el.files[0]?.name),
            'example.txt'
          );
          const answer = page
            .locator('.application-question')
            .filter({ hasText: 'future require sponsorship' })
            .locator('input:checked');
          assert.equal(await answer.inputValue(), 'Yes');
        }
        if (site === 'Workday fixture') {
          assert.equal(await page.locator('#kept').inputValue(), 'kept@example.invalid');
          await page.locator('form').evaluate((form) => {
            form.innerHTML =
              '<h1 aria-current="step">Next step</h1><label>Last name<input id="last"></label><button>Submit</button>';
          });
          assert.equal(await page.locator('#last').inputValue(), '');
          assert.match(
            await inPanel(function () {
              return this.querySelector('[role=status]').textContent;
            }),
            /New application step/
          );
          await click('section button.main');
          await page.waitForFunction(() => document.querySelector('#last').value === 'Example');
        }
        if (site === 'Ashby') {
          const item = page
            .locator('.ashby-application-form-field-entry')
            .filter({ hasText: 'minimum of 7 years' });
          assert.equal(await item.locator('[aria-pressed=true]').count(), 0);
          const question = 'Please elaborate on your experience';
          const entry = page.locator('.ashby-application-form-field-entry').filter({ hasText: question });
          await entry.locator('textarea').fill('A synthetic test response.');
          await inPanel(
            function (q) {
              [...this.querySelectorAll('li input[type=checkbox]')]
                .find((input) => input.closest('li').textContent.startsWith(q))
                .focus();
            },
            [question]
          );
          await page.keyboard.press('Space');
          assert.equal(
            await inPanel(function () {
              return this.querySelectorAll('input:checked').length;
            }),
            1
          );
          await click('section > button:last-child');
          for (let i = 0; i < 30 && !profile.answers.length; i++) await page.waitForTimeout(100);
          if (!profile.answers.length)
            console.error(
              'Save status',
              await inPanel(function () {
                return [
                  this.querySelector('[role=status]').textContent,
                  this.querySelectorAll('input:checked').length,
                  this.querySelector('section > button:last-child').outerHTML,
                ];
              })
            );
          assert.deepEqual(profile.answers, [
            { question: await entry.locator('label').innerText(), answer: 'A synthetic test response.' },
          ]);
        }
        assert.equal(await page.evaluate(() => window.__smokeSubmits), 0);
        assert.deepEqual(errors, []);
        assert.ok(results.some(([group]) => group.startsWith('Needs you')));
      } finally {
        await page.close();
      }
    }
    assert.ok(requests.includes('/api/autofill/resumes/sample/file'));
    assert.ok(requests.every((p) => p.startsWith('/api/autofill/')));
    assert.equal(
      requests.filter((p) => p.endsWith('/profile')).length,
      1,
      'profile was cached across three tabs'
    );
    await popup.reload();
    await popup.getByText('Connected as pat@example.invalid').waitFor();
    assert.equal(
      requests.filter((p) => p.endsWith('/profile')).length,
      2,
      'saving invalidated the profile cache'
    );
    // Multi-step form, panel never opened: each step's answers are held, and
    // the save card appears only once the page confirms the submission.
    {
      profile.answers = [];
      const page = await context.newPage();
      try {
        await page.route('https://steps.myworkdayjobs.com/**', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body:
              '<div data-automation-id="jobApplicationPage"><form id="f" onsubmit="event.preventDefault()">' +
              '<h1 aria-current="step">Questions</h1><label>Favorite language for systems work<input id="q1"></label>' +
              '<button id="next">Next</button></form></div><script>' +
              'document.getElementById("next").onclick=()=>setTimeout(()=>{document.getElementById("f").innerHTML=' +
              '`<h1 aria-current="step">More</h1><label>Why this team in particular<textarea id="q2"></textarea></label>' +
              '<button type="button" id="submit">Submit application</button>`;' +
              'document.getElementById("submit").onclick=()=>setTimeout(()=>{document.body.innerHTML=' +
              '"<h1>Thank you for applying</h1><p>Your application was submitted.</p>"},300)},200);</script>',
          })
        );
        await page.goto('https://steps.myworkdayjobs.com/Jobs/apply', { waitUntil: 'domcontentloaded' });
        await page.locator('#q1').fill('Rust');
        await page.waitForTimeout(500);
        await page.locator('#next').click();
        await page.locator('#q2').fill('A synthetic test answer.');
        await page.locator('#submit').click();
        await page.getByText('Thank you for applying').waitFor();
        const cdp = await context.newCDPSession(page);
        let card;
        for (let i = 0; i < 80 && !card; i++) {
          await page.waitForTimeout(100);
          const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
          const shadows = (n) => [...(n.shadowRoots || []), ...(n.children || []).flatMap(shadows)];
          for (const node of shadows(root)) {
            const found = await cdp.send('DOM.querySelector', { nodeId: node.nodeId, selector: '.card' });
            if (found.nodeId) card = found.nodeId;
          }
        }
        assert.ok(card, 'save card appears after the confirmation');
        const { object } = await cdp.send('DOM.resolveNode', { nodeId: card });
        const call = async (fn) =>
          (
            await cdp.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: fn.toString(),
              returnByValue: true,
            })
          ).result.value;
        assert.deepEqual(
          await call(function () {
            return [this.querySelector('h2').textContent, [...this.querySelectorAll('li label')].map((l) => l.textContent)];
          }),
          ['Save 2 new answers?', ['Favorite language for systems work', 'Why this team in particular']]
        );
        const point = await call(function () {
          const r = this.querySelector('button.main').getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2];
        });
        await page.mouse.click(...point);
        for (let i = 0; i < 30 && profile.answers.length < 2; i++) await page.waitForTimeout(100);
        assert.deepEqual(
          profile.answers.map((a) => [a.question, a.answer]),
          [
            ['Favorite language for systems work', 'Rust'],
            ['Why this team in particular', 'A synthetic test answer.'],
          ]
        );
        console.log('Multi-step save offer: ok');
      } finally {
        await page.close();
      }
    }
    await popup.locator('#autofillToken').fill('invalid-test-token');
    await popup.locator('#connect').click();
    await popup.getByText('Token rejected.', { exact: false }).waitFor();
  } finally {
    if (context) await context.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
if (process.argv.includes('--live'))
  live().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
