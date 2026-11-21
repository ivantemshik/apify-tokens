import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { PochtiReader, runSsh } from '../src/pochti.js';

const config = getConfig();
const domain = 'mint.kurilka365.ru';
const intentFile = 'data/new-mail-intent.json';
let intent;
try { intent = JSON.parse(await fs.readFile(intentFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  intent = { domain, requestId: `apify-${randomUUID()}` };
  await fs.writeFile(intentFile, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
}
if (intent.domain !== domain) throw new Error('Запрос нового ящика относится к другому домену.');
const reader = new PochtiReader(config.mail.pochti);
await reader.checkFiles();
const source = await fs.readFile(new URL('./pochti-issue.py', import.meta.url), 'utf8');
const result = await runSsh(config.mail.pochti, source, {
  email: config.mail.pochti.anchorEmail, domain, requestId: intent.requestId, config: config.mail.pochti.remoteConfig,
});
if (typeof result.address !== 'string' || !result.address.endsWith(`@${domain}`)) throw new Error('Сервер не вернул новый адрес нужного домена.');
await reader.probe(result.address);
const current = (await fs.readFile('data/live-accounts.jsonl', 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const selected = [{ email: result.address, name: 'Automation User' }, ...current.slice(1)].slice(0,5);
await fs.writeFile('data/live-accounts.jsonl', selected.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
await fs.writeFile('data/first-live-account.jsonl', JSON.stringify(selected[0]) + '\n', { mode: 0o600 });
const plan = JSON.parse(await fs.readFile('data/live-run-plan.json', 'utf8'));
plan.accounts = selected.map(row => row.email);
plan.firstAddressNewlyIssued = true;
await fs.writeFile('data/live-run-plan.json', JSON.stringify(plan,null,2));
console.log(`Создан и проверен новый ящик: ${result.address}. Код и конфигурация pochti не менялись.`);
