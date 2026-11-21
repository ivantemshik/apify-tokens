import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { PochtiReader, runSsh } from '../src/pochti.js';

const config = getConfig();
const file = 'data/new-mail-batch-intents.json';
let intents;
try { intents = JSON.parse(await fs.readFile(file, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const first = JSON.parse(await fs.readFile('data/new-mail-intent.json', 'utf8'));
  intents = [first, ...Array.from({ length: 4 }, () => ({ domain: 'mint.kurilka365.ru', requestId: `apify-${randomUUID()}` }))];
  await fs.writeFile(file, JSON.stringify(intents), { flag: 'wx', mode: 0o600 });
}
const source = await fs.readFile(new URL('./pochti-issue.py', import.meta.url), 'utf8');
const reader = new PochtiReader(config.mail.pochti);
await reader.checkFiles();
const accounts = [];
for (const [index, intent] of intents.entries()) {
  const result = await runSsh(config.mail.pochti, source, {
    email: config.mail.pochti.anchorEmail, domain: intent.domain, requestId: intent.requestId, config: config.mail.pochti.remoteConfig,
  });
  if (typeof result.address !== 'string' || !result.address.endsWith(`@${intent.domain}`)) throw new Error('Некорректный новый адрес.');
  await reader.probe(result.address);
  accounts.push({ email: result.address, name: `Automation User ${index + 1}` });
}
if (accounts.length !== 5 || new Set(accounts.map(row => row.email)).size !== 5) throw new Error('Нужны пять разных новых адресов.');
await fs.writeFile('data/live-accounts.jsonl', accounts.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
await fs.writeFile('data/first-live-account.jsonl', JSON.stringify(accounts[0]) + '\n', { mode: 0o600 });
const plan = JSON.parse(await fs.readFile('data/live-run-plan.json', 'utf8'));
plan.accounts = accounts.map(row => row.email); plan.allAddressesNewlyIssued = true;
await fs.writeFile('data/live-run-plan.json', JSON.stringify(plan, null, 2));
console.log('Подготовлены 5 новых уникальных ящиков mint, включая уже начатый аккаунт. Готовые чужие адреса не используются.');
