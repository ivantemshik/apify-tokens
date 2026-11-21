import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { getConfig, validateConfig } from '../src/config.js';
import { sshArguments, runSsh, PochtiMailbox } from '../src/pochti.js';
import { verificationLink, createMailbox } from '../src/mail.js';

const config = getConfig({ MAIL_PROVIDER: 'pochti' }).mail;

function fakeSsh(result, observe = () => {}, code = 0) {
  return (exe, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('finish', () => {
      observe({ exe, args, options, request: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      child.stdout.write(JSON.stringify(result));
      child.emit('close', code);
    });
    return child;
  };
}

test('pochti SSH preserves host checking and keeps mailbox data in stdin', async () => {
  const request = { action: 'probe', email: 'mine@example.com', config: '/etc/tempmail/config.json' };
  const result = await runSsh(config.pochti, 'print("fixture")', request, fakeSsh({ ok: true, mailbox: { email: request.email } }, call => {
    assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(call.args.includes('UpdateHostKeys=no'));
    assert.ok(call.args.includes('BatchMode=yes'));
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, undefined);
    assert.ok(!call.args.some(value => value.includes(request.email)));
    assert.deepEqual(call.request, request);
    assert.match(call.args.at(-1), /^python3 -B -c /);
  }));
  assert.equal(result.mailbox.email, request.email);
  assert.throws(() => sshArguments({ ...config.pochti, sshHost: 'root@example.com; touch /tmp/file' }, ''), { code: 'POCHTI_CONFIG' });
});

test('pochti does not reflect remote errors or SSH diagnostic text', async () => {
  await assert.rejects(runSsh(config.pochti, '', {}, fakeSsh({ ok: false, error: 'remote-private-token' })), error => {
    assert.equal(error.code, 'MAIL_REMOTE_READ');
    assert.ok(!error.message.includes('remote-private-token'));
    return true;
  });
  await assert.rejects(runSsh(config.pochti, '', {}, fakeSsh({ ok: false, error: 'MAIL_EXPIRED' })), { code: 'MAIL_EXPIRED' });
  await assert.rejects(runSsh(config.pochti, '', {}, fakeSsh({}, () => {}, 255)), { code: 'POCHTI_SSH' });
});

test('pochti mailbox maps existing SQLite message format and bracketed links', async () => {
  const since = Date.now();
  const calls = [];
  const reader = {
    probe: async email => ({ ok: true, mailbox: { email, expiresAt: Math.floor(since / 1000) + 3600 } }),
    request: async (...args) => {
      calls.push(args);
      return { ok: true, messages: [{ sender: 'Apify <noreply@apify.com>', received_at: Math.floor(since / 1000), body: 'Подтвердить [https://console.apify.com/verify-email?token=fixture&code=123]\n' }] };
    },
  };
  const mailbox = new PochtiMailbox(config, 'mine@example.com', verificationLink, { reader });
  await mailbox.connect();
  assert.equal(await mailbox.wait(since), 'https://console.apify.com/verify-email?token=fixture&code=123');
  assert.deepEqual(calls[0], ['messages', 'mine@example.com', since]);
  assert.ok(mailbox.metadata.expiresAt > since / 1000);
  await mailbox.close();
});

test('expired pochti address stops before waiting or registration', async () => {
  let reads = 0;
  const mailbox = new PochtiMailbox(config, 'mine@example.com', verificationLink, {
    reader: { probe: async () => { throw Object.assign(new Error('expired'), { code: 'MAIL_EXPIRED' }); }, request: async () => { reads++; } },
  });
  await assert.rejects(mailbox.connect(), { code: 'MAIL_EXPIRED' });
  assert.equal(reads, 0);
});

test('mail-only config checks do not require solver credentials or a mailbox password', () => {
  const full = getConfig({ MAIL_PROVIDER: 'pochti' });
  assert.deepEqual(validateConfig(full, [{ email: 'mine@example.com' }], {}, { mailOnly: true }), []);
  assert.equal(createMailbox(full.mail, { email: 'mine@example.com' }).constructor.name, 'PochtiMailbox');
});
