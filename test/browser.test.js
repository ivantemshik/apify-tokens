import test from 'node:test';
import assert from 'node:assert/strict';
import { chromiumRuntime } from '../src/runtime.js';
import { ApifyBrowser, defaultSelectors, detectRecaptcha, applyRecaptchaToken } from '../src/browser.js';

// All requests are intercepted. No account is created and no solver is charged.
async function fixture(t) {
  const chromium = await chromiumRuntime();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const requests = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    let html = '<!doctype html><html><body>Unexpected request</body></html>';
    if (url.pathname === '/sign-up' || url.pathname === '/sign-in') {
      const login = url.pathname === '/sign-in';
      html = `<!doctype html><html><body>
        <label>Email<input type="email" name="email"></label><button id="next">Next</button>
        <script>
        document.querySelector('#next').onclick = () => {
          document.body.innerHTML = '<label>Password<input type="password"></label><button id="submit">${login ? 'Log in' : 'Sign up'}</button>';
          document.querySelector('#submit').onclick = () => {
            ${login ? "location.href = '/';" : `
              document.querySelector('#submit').disabled = true;
              const widget = document.createElement('div'); widget.className = 'g-recaptcha';
              widget.setAttribute('data-sitekey', 'fixture-site-key'); widget.setAttribute('data-callback', 'acceptCaptcha');
              document.body.append(widget);
              const field = document.createElement('textarea'); field.name = 'g-recaptcha-response'; document.body.append(field);
              window.acceptCaptcha = token => {
                if (token !== 'fixture-solution') throw new Error('Invalid fixture token');
                location.href = '/profile';
              };
            `}
          };
        };
        </script></body></html>`;
    } else if (url.pathname === '/profile') {
      html = `<!doctype html><label>Your name<input name="name" autocomplete="name"></label><button id="continue">Continue</button><script>
        document.querySelector('#continue').onclick = () => {
          if (!document.querySelector('input').value) throw new Error('Name is required');
          location.href = '/check-email';
        };
        </script>`;
    } else if (url.pathname === '/check-email') {
      html = '<!doctype html><h1>Check your email</h1><p>We sent a verification email.</p>';
    } else if (url.pathname === '/verify-email') {
      html = '<!doctype html><script>location.href="/"</script>';
    } else if (url.pathname === '/') {
      html = '<!doctype html><a href="/actors">Actors</a><a href="/settings">Settings</a>';
    } else if (url.pathname === '/settings/integrations') {
      html = `<!doctype html><button id="new">Create a new token</button><script>
        document.querySelector('#new').onclick = () => {
          const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
          dialog.innerHTML = '<input name="description"><button id="create">Create</button>';
          document.body.append(dialog);
          document.querySelector('#create').onclick = () => {
            if (!document.querySelector('input').value) throw new Error('Description missing');
            dialog.innerHTML = '<input readonly value="apify_api_fixtureTokenValue12345678901234567890">';
          };
        };
        </script>`;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  t.after(() => browser.close());
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  return { page, requests };
}

test('browser completes two-step signup, CAPTCHA callback, mail verification and token capture on fixture', { timeout: 30000 }, async t => {
  const { page, requests } = await fixture(t);
  let solves = 0;
  const solver = {
    config: { timeoutMs: 1000, maxTasks: 2 },
    solve: async challenge => {
      solves++;
      assert.equal(challenge.siteKey, 'fixture-site-key');
      assert.equal(challenge.websiteURL, 'https://console.apify.com/sign-up');
      return 'fixture-solution';
    },
  };
  const flow = new ApifyBrowser(page, defaultSelectors, solver);
  assert.equal(await flow.auth('mine@example.com', 'fixture-password'), 'verification');
  assert.equal(solves, 1);
  assert.equal(await flow.verify('https://console.apify.com/verify-email?token=fixture'), true);
  const events = [];
  const token = await flow.createToken('fixture-description', async () => { events.push('creating'); }, async token => { events.push('saved'); assert.match(token, /^apify_api_/); });
  assert.match(token, /^apify_api_fixture/);
  assert.deepEqual(events, ['creating', 'saved']);
  assert.ok(requests.every(url => new URL(url).hostname === 'console.apify.com'));
});

test('browser resumes through sign-in without submitting signup again', { timeout: 15000 }, async t => {
  const { page, requests } = await fixture(t);
  const solver = { config: { timeoutMs: 1000, maxTasks: 1 }, solve: async () => assert.fail('No CAPTCHA expected') };
  const flow = new ApifyBrowser(page, defaultSelectors, solver);
  assert.equal(await flow.auth('mine@example.com', 'fixture-password', { resume: true }), 'authenticated');
  assert.ok(requests.some(url => url.endsWith('/sign-in')));
  assert.ok(!requests.some(url => url.endsWith('/sign-up')));
});

test('challenge detection ignores Turnstile and token injection invokes nested reCAPTCHA callback', { timeout: 15000 }, async t => {
  const { page } = await fixture(t);
  await page.goto('https://console.apify.com/');
  await page.setContent('<div class="cf-turnstile" data-sitekey="not-recaptcha"></div>');
  assert.equal(await page.evaluate(detectRecaptcha), null);
  await page.setContent('<div class="g-recaptcha" data-sitekey="actual-recaptcha" data-size="invisible"></div><textarea name="g-recaptcha-response"></textarea>');
  await page.evaluate(() => { window.___grecaptcha_cfg = { clients: { 0: { nested: { callback: token => { document.body.dataset.token = token; } } } } }; });
  const challenge = await page.evaluate(detectRecaptcha);
  assert.equal(challenge.invisible, true);
  assert.equal(challenge.siteKey, 'actual-recaptcha');
  assert.deepEqual(await page.evaluate(applyRecaptchaToken, 'fixture-token'), { fields: 1, callbacks: 1 });
  assert.equal(await page.locator('textarea').inputValue(), 'fixture-token');
  assert.equal(await page.getAttribute('body', 'data-token'), 'fixture-token');
});
