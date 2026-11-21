import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/vault.js';
import { CaptchaSolver, buildTask } from '../src/captcha.js';
import { HttpMailbox, verificationLink } from '../src/mail.js';
import { getConfig, validateConfig, readAccounts } from '../src/config.js';
import { validateToken } from '../src/browser.js';
import { jsonRequest } from '../src/errors.js';
import { makeRunPlan } from '../src/run-plan.js';
import { CaptchaBudget } from '../src/captcha-budget.js';

const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const captchaConfig = { provider: 'capsolver', apiKey: 'private-test-key', maxTasks: 2, timeoutMs: 10000 };
const challenge = { siteKey: 'test-site-key', websiteURL: 'https://console.apify.com/sign-up', version: 'v2' };

test('paid-task budget survives restart and uncertain createTask cannot reuse its reserve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apify-budget-'));
  try {
    const file = join(dir, 'budget.json');
    const budget = new CaptchaBudget(file, '0.02');
    const first = await budget.reserve();
    await budget.settle(first, '0.00299');
    await budget.reserve();
    const resumed = new CaptchaBudget(file, '0.02');
    await resumed.load();
    assert.equal(resumed.entries[0].costMicros, 2990);
    await assert.rejects(resumed.reserve(), { code: 'CAPTCHA_TOTAL_BUDGET' });
    const solver = new CaptchaSolver(captchaConfig, { budget: resumed, fetcher: async () => assert.fail('No paid request after budget exhausted') });
    await assert.rejects(solver.solve(challenge), { code: 'CAPTCHA_TOTAL_BUDGET' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run target counts verified tokens and retains unverified captures for recovery', () => {
  const accounts = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ email: `${name}@example.com` }));
  const records = {
    'a@example.com': { stage: 'done', token: 'verified-token' },
    'b@example.com': { stage: 'token_captured', token: 'unverified-token' },
    'c@example.com': { stage: 'done' },
  };
  const plan = makeRunPlan(accounts, records, 5);
  assert.equal(plan.ready, 1);
  assert.equal(plan.remaining, 4);
  assert.equal(plan.candidates[0].email, 'b@example.com');
  assert.equal(plan.candidates.length, 5);
  assert.equal(makeRunPlan(accounts, records, 1).remaining, 0);
});

test('solver polls the same paid task and enforces the task limit', async () => {
  const calls = [];
  const results = [{ errorId: 0, taskId: 'task1' }, { errorId: 0, status: 'processing' }, { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'solution' } }];
  let clock = 0;
  const solver = new CaptchaSolver({ ...captchaConfig, maxTasks: 1 }, {
    fetcher: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(results.shift()); },
    sleep: async ms => { clock += ms; }, now: () => clock,
  });
  assert.equal(await solver.solve(challenge), 'solution');
  assert.equal(calls.filter(c => c.url.endsWith('/createTask')).length, 1);
  assert.equal(calls[2].body.taskId, 'task1');
  await assert.rejects(solver.solve(challenge), { code: 'CAPTCHA_BUDGET' });
});

test('ambiguous createTask timeout does not produce a second paid request', async () => {
  let calls = 0;
  const solver = new CaptchaSolver(captchaConfig, { fetcher: async () => { calls++; throw new Error('secret: private-test-key'); } });
  await assert.rejects(solver.solve(challenge), error => error.code === 'NETWORK_ERROR' && !error.message.includes('private-test-key'));
  assert.equal(calls, 1);
});

test('2captcha Enterprise uses its own task name and enterprise payload', () => {
  const task = buildTask('2captcha', { ...challenge, enterprise: true, dataS: 'additional-data' });
  assert.equal(task.type, 'RecaptchaV2EnterpriseTaskProxyless');
  assert.deepEqual(task.enterprisePayload, { s: 'additional-data' });
  assert.throws(() => buildTask('capsolver', { ...challenge, version: 'v3' }), { code: 'CAPTCHA_UNSUPPORTED' });
});

test('solver reports provider errors without reflecting response secrets', async () => {
  const solver = new CaptchaSolver(captchaConfig, { fetcher: async () => response({ errorId: 1, errorCode: 'ERROR_KEY_DOES_NOT_EXIST', errorDescription: 'private-test-key' }) });
  await assert.rejects(solver.solve(challenge), e => e.code === 'CAPTCHA_ERROR_KEY_DOES_NOT_EXIST' && !e.message.includes('private-test-key'));
});

test('solver preserves actionable provider code on HTTP 401 without leaking description', async () => {
  const solver = new CaptchaSolver(captchaConfig, { fetcher: async () => new Response(JSON.stringify({
    errorId: 1, errorCode: 'ERROR_KEY_DENIED_ACCESS', errorDescription: 'private-test-key',
  }), { status: 401 }) });
  await assert.rejects(solver.balance(), error => {
    assert.equal(error.code, 'CAPTCHA_ERROR_KEY_DENIED_ACCESS');
    assert.ok(!error.message.includes('private-test-key'));
    return true;
  });
});

test('mail verification binds recipient, time, sender and exact destination host', () => {
  const since = Date.now();
  const valid = { date: new Date(since).toISOString(), to: 'Person <mine@example.com>', from: 'Apify <noreply@apify.com>', text: 'Open https://console.apify.com/verify-email?token=abc&email=x' };
  assert.match(verificationLink(valid, 'mine@example.com', since), /^https:\/\/console.apify.com\/verify-email/);
  assert.equal(verificationLink({ ...valid, to: 'other@example.com' }, 'mine@example.com', since), null);
  assert.equal(verificationLink({ ...valid, date: new Date(since - 120000).toISOString() }, 'mine@example.com', since), null);
  assert.equal(verificationLink({ ...valid, date: '' }, 'mine@example.com', since), null);
  assert.equal(verificationLink({ ...valid, from: 'noreply@evilapify.com' }, 'mine@example.com', since), null);
  for (const text of [
    'https://console.apify.com.attacker.example/verify-email?token=abc',
    'https://console.apify.com@attacker.example/verify-email?token=abc',
    'https://attacker@console.apify.com/verify-email?token=abc',
    'https://console.apify.com:8443/verify-email?token=abc',
    'https://console.apify.com/actors/evil',
  ]) assert.equal(verificationLink({ ...valid, text }, 'mine@example.com', since), null);
});

test('HTTP mailbox encodes email, authenticates and waits for matching fresh mail', async () => {
  let clock = 100000;
  let calls = 0;
  const mailbox = new HttpMailbox({ apiUrl: 'https://mail.example/messages?to={email}', apiToken: 'mail-secret', timeoutMs: 10000, pollMs: 1000 }, 'mine+tag@example.com', {
    now: () => clock, sleep: async ms => { clock += ms; },
    fetcher: async (url, options) => {
      assert.ok(url.endsWith('mine%2Btag%40example.com'));
      assert.equal(options.headers.Authorization, 'Bearer mail-secret');
      return response({ messages: ++calls < 2 ? [] : [{ to: 'mine+tag@example.com', from: 'noreply@apify.com', date: new Date(clock).toISOString(), html: '<a href="https://console.apify.com/verify-email?token=x&amp;id=y">Verify</a>' }] });
    },
  });
  assert.equal(await mailbox.wait(100000), 'https://console.apify.com/verify-email?token=x&id=y');
  assert.equal(calls, 2);
});

test('vault encrypts, round-trips, rejects another key and detects tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apify-vault-'));
  const file = join(dir, 'accounts.vault.json');
  const key = randomBytes(32).toString('hex');
  const vault = new Vault(file, key);
  try {
    await vault.lock();
    await vault.set('mine@example.com', { password: 'private-password', token: 'private-token', stage: 'token_captured' });
    const source = await readFile(file, 'utf8');
    assert.ok(!source.includes('private-password') && !source.includes('private-token') && !source.includes('mine@example.com'));
    const other = new Vault(file, key);
    await assert.rejects(other.lock(), { code: 'VAULT_LOCKED' });
    await other.load();
    assert.equal(other.get('mine@example.com').token, 'private-token');
    const wrong = new Vault(file, randomBytes(32).toString('hex'));
    await assert.rejects(wrong.load(), { code: 'VAULT_DECRYPT' });
    const data = JSON.parse(source);
    const bytes = Buffer.from(data.payload, 'base64'); bytes[0] ^= 1;
    data.payload = bytes.toString('base64');
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(other.load(), { code: 'VAULT_DECRYPT' });
  } finally { await vault.unlock(); await rm(dir, { recursive: true, force: true }); }
});

test('token validation checks actual email and keeps credentials out of URL', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.apify.com/v2/users/me');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return response({ data: { id: 'user1', email: 'mine@example.com' } });
  };
  assert.equal(await validateToken('private-token', 'mine@example.com', fetcher), 'user1');
  await assert.rejects(validateToken('private-token', 'other@example.com', fetcher), { code: 'TOKEN_IDENTITY' });
});

test('HTTP request forbids redirects that could leak credentials', async () => {
  await jsonRequest('https://mail.example', {}, async (_, options) => {
    assert.equal(options.redirect, 'error');
    return response({ ok: true });
  });
});

test('configuration refuses incomplete inbox settings and insecure API URL', () => {
  const config = getConfig({ VAULT_KEY: 'a'.repeat(64), CAPTCHA_API_KEY: 'captcha-secret' });
  assert.ok(validateConfig(config, [{ email: 'mine@example.com' }]).includes('IMAP_HOST'));
  const http = getConfig({ VAULT_KEY: 'a'.repeat(64), CAPTCHA_API_KEY: 'key', MAIL_PROVIDER: 'http', MAIL_API_URL: 'https://mail.example/inbox/{email}' });
  assert.deepEqual(validateConfig(http, []), []);
  http.mail.apiUrl = 'http://mail.example/{email}';
  assert.equal(validateConfig(http, []).length, 1);
  assert.throws(() => getConfig({ MAX_CAPTCHA_TASKS_PER_ACCOUNT: '-1' }), { code: 'CONFIG' });
});

test('account parser rejects duplicates instead of registering twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apify-accounts-'));
  const file = join(dir, 'accounts.jsonl');
  try {
    await writeFile(file, '{"email":"Mine@example.com"}\n{"email":"mine@example.com"}\n');
    await assert.rejects(readAccounts(file), { code: 'ACCOUNTS_FILE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
