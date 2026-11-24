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
  const gmailAsks = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.headers.authorization !== 'Bearer test-only') {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/api/autofill/workday-login')
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ email: 'pat@example.invalid', password: 'Str0ng!Password-x', updatedAt: '2026-01-01T00:00:00Z' }));
    else if (req.url === '/api/autofill/profile')
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
    } else if (req.url === '/api/autofill/gmail/code' && req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      gmailAsks.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'A1B2C3D4', messageId: 'm1' }));
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
    await popup.locator('#connectCard summary').click();
    await popup.locator('#portalUrl').fill('http://127.0.0.1:' + server.address().port);
    await popup.locator('#autofillToken').fill('test-only');
    await popup.locator('#connect').click();
    await popup.locator('#account', { hasText: 'pat@example.invalid' }).waitFor();
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
        await click('button.tab');
        for (
          let i = 0;
          i < 50 &&
          (await inPanel(function () {
            return this.querySelector('section button.pill').disabled;
          }));
          i++
        )
          await page.waitForTimeout(100);
        await click('section button.pill');
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
          await click('section button.pill');
          await page.waitForFunction(() => document.querySelector('#last').value === 'Example');
        }
        if (site === 'Ashby') {
          const item = page
            .locator('.ashby-application-form-field-entry')
            .filter({ hasText: 'minimum of 7 years' });
          assert.equal(await item.locator('[aria-pressed=true]').count(), 0);
          // Saving answers is offered after you submit (the multi-step check
          // below), never with checkboxes inside the panel.
          assert.deepEqual(
            await inPanel(function () {
              return [
                this.querySelectorAll('li input[type=checkbox]').length,
                [...this.querySelectorAll('button')].some((b) => /save my answers/i.test(b.textContent)),
              ];
            }),
            [0, false]
          );
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
    // Workday sign-in with the password saved on the job board (fixture with Workday's
    // markup: "Sign in with email", a click_filter overlay over Sign In, and
    // the create-account form). Nothing leaves the machine.
    {
      const page = await context.newPage();
      try {
        await page.route('https://login.myworkdayjobs.com/**', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body:
              '<div data-automation-id="applyFlowPage"><div data-automation-id="signInContent" id="panel">' +
              '<button data-automation-id="SignInWithEmailButton" id="byEmail">Sign in with email</button></div></div><script>' +
              'const panel=document.getElementById("panel");' +
              'function signInForm(){panel.innerHTML=`<form data-automation-id="signInFormo"><div data-automation-id="formField-email"><label for="e">Email Address</label><input id="e" data-automation-id="email"></div>' +
              '<div data-automation-id="formField-password"><label for="p">Password</label><input id="p" type="password" data-automation-id="password"></div>' +
              '<div data-automation-id="noCaptchaWrapper" style="position:relative;width:120px;height:40px"><button data-automation-id="signInSubmitButton" style="width:120px;height:40px">Sign In</button>' +
              '<div data-automation-id="click_filter" id="filter" style="position:absolute;inset:0"></div></div>' +
              '<button type="button" data-automation-id="createAccountLink" id="createLink">Create Account</button></form>`;' +
              'document.getElementById("filter").addEventListener("click",()=>{window.__signedIn={email:document.getElementById("e").value,password:document.getElementById("p").value};setTimeout(()=>panel.remove(),100)});}' +
              'document.getElementById("byEmail").onclick=signInForm;</script>',
          })
        );
        await page.goto('https://login.myworkdayjobs.com/en-US/External/job/Boston/SWE_1/apply/applyManually', { waitUntil: 'domcontentloaded' });
        await page.mouse.click(5, 5); // the user has interacted with the page
        await page.waitForFunction(() => window.__signedIn, null, { timeout: 15000 });
        assert.deepEqual(await page.evaluate(() => window.__signedIn), { email: 'pat@example.invalid', password: 'Str0ng!Password-x' });
        console.log('Workday sign-in: ok');

        // Create-account form: both password boxes filled, "I agree" and the
        // Create Account button left alone.
        await page.route('https://create.myworkdayjobs.com/**', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body:
              '<div data-automation-id="applyFlowPage"><div data-automation-id="signInContent">' +
              '<form><div data-automation-id="formField-email"><label for="e">Email Address</label><input id="e" data-automation-id="email"></div>' +
              '<div data-automation-id="formField-password"><label for="p">Password</label><input id="p" type="password" data-automation-id="password"></div>' +
              '<div data-automation-id="formField-verifyPassword"><label for="v">Verify New Password</label><input id="v" type="password" data-automation-id="verifyPassword"></div>' +
              '<label for="beecatcher">Enter website. This input is for robots only</label><input id="beecatcher" data-automation-id="beecatcher">' +
              '<div data-automation-id="formField-"><input type="checkbox" id="agree" data-automation-id="createAccountCheckbox"><label for="agree">I agree</label></div>' +
              '<button data-automation-id="createAccountSubmitButton" id="create" onclick="window.__created={agree:document.getElementById(\'agree\').checked,e:document.getElementById(\'e\').value,v:document.getElementById(\'v\').value,bot:document.getElementById(\'beecatcher\').value};this.closest(\'form\').remove();return false">Create Account</button></form></div></div>',
          })
        );
        await page.goto('https://create.myworkdayjobs.com/en-US/External/job/1/apply', { waitUntil: 'domcontentloaded' });
        await page.mouse.click(5, 5);
        // Email and both passwords filled, "I agree" ticked, Create Account
        // pressed once; the bot-trap field left empty.
        await page.waitForFunction(() => window.__created, null, { timeout: 15000 });
        assert.deepEqual(await page.evaluate(() => window.__created), {
          agree: true,
          e: 'pat@example.invalid',
          v: 'Str0ng!Password-x',
          bot: '',
        });
        console.log('Workday create account: ok');

        // With a CAPTCHA on the form: filled, but nothing is ticked or pressed.
        await page.route('https://captcha.myworkdayjobs.com/**', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body:
              '<div data-automation-id="applyFlowPage"><div data-automation-id="signInContent">' +
              '<form><div data-automation-id="formField-email"><input id="e" data-automation-id="email"></div>' +
              '<div data-automation-id="formField-password"><input id="p" type="password" data-automation-id="password"></div>' +
              '<div data-automation-id="formField-verifyPassword"><input id="v" type="password" data-automation-id="verifyPassword"></div>' +
              '<div class="g-recaptcha"></div>' +
              '<div data-automation-id="formField-"><input type="checkbox" id="agree" data-automation-id="createAccountCheckbox"></div>' +
              '<button data-automation-id="createAccountSubmitButton" onclick="window.__created=true;return false">Create Account</button></form></div></div>',
          })
        );
        await page.goto('https://captcha.myworkdayjobs.com/en-US/External/job/1/apply', { waitUntil: 'domcontentloaded' });
        await page.mouse.click(5, 5);
        await page.waitForFunction(() => document.getElementById('v').value, null, { timeout: 15000 });
        await page.waitForTimeout(1500);
        assert.deepEqual(await page.evaluate(() => ({ agree: document.getElementById('agree').checked, created: !!window.__created })), {
          agree: false,
          created: false,
        });
        console.log('Workday create account with a CAPTCHA left to you: ok');
      } finally {
        await page.close();
      }
    }
    // Greenhouse security code boxes: the code is asked from the portal for
    // this board and company, then filled one character per box.
    {
      const page = await context.newPage();
      try {
        await page.route('https://job-boards.greenhouse.io/codes/**', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body:
              '<title>Job Application for Software Engineer at Codes Inc</title>' +
              '<div id="application-form"><p>Enter the security code we emailed you</p>' +
              Array.from({ length: 8 }, (_, i) => `<input id="security-input-${i}" maxlength="1">`).join('') +
              '</div>',
          })
        );
        await page.goto('https://job-boards.greenhouse.io/codes/jobs/1', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('security-input-7').value, null, { timeout: 15000 });
        assert.equal(
          await page.evaluate(() => [...document.querySelectorAll('[id^="security-input-"]')].map((i) => i.value).join('')),
          'A1B2C3D4'
        );
        assert.deepEqual(gmailAsks[0], { site: 'greenhouse', tenant: 'codes', company: 'Codes Inc', length: 8, charset: 'alnum', skip: [] });
        console.log('Greenhouse code filled for this company: ok');
      } finally {
        await page.close();
      }
    }
    await popup.locator('#disconnect').click();
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
