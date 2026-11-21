import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { PochtiReader, runSsh } from '../src/pochti.js';
import { Vault } from '../src/vault.js';

const config = getConfig();
const pointer = 'data/current-new-batch.json';
let manifest;
try { manifest = JSON.parse(await fs.readFile(pointer, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const directory = `data/runs/2026-11-21-${randomUUID().slice(0,8)}`;
  await fs.mkdir(directory, { recursive: true });
  const vault = new Vault(config.vaultFile, config.vaultKey);
  await vault.load();
  manifest = {
    directory, target: 5, budgetUsd: '0.10',
    intents: Array.from({ length: 5 }, () => ({ domain: 'mint.kurilka365.ru', requestId: `apify-${randomUUID()}` })),
    previousTokens: Object.values(vault.records).filter(row => row.stage === 'done' && row.token).map(row => createHash('sha256').update(row.token).digest('hex')),
  };
  await fs.writeFile(pointer, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
}
const reader = new PochtiReader(config.mail.pochti);
await reader.checkFiles();
const known = JSON.parse(await fs.readFile('data/new-mail-batch-intents.json', 'utf8'));
const ownerSource = await fs.readFile(new URL('./pochti-owner.py', import.meta.url), 'utf8');
const owner = await runSsh(config.mail.pochti, ownerSource, { config: config.mail.pochti.remoteConfig, requestIds: known.map(row => row.requestId) });
await fs.writeFile(`${manifest.directory}/owner.json`, JSON.stringify(owner), { mode: 0o600 });
console.log(`Владелец почты определён: ${owner.source}.`);
const source = await fs.readFile(new URL('./pochti-issue.py', import.meta.url), 'utf8');
const accounts = [];
for (const [index, intent] of manifest.intents.entries()) {
  const result = await runSsh(config.mail.pochti, source, {
    email: config.mail.pochti.anchorEmail, ownerId: owner.ownerId,
    domain: intent.domain, requestId: intent.requestId, config: config.mail.pochti.remoteConfig,
  });
  if (typeof result.address !== 'string' || !result.address.endsWith(`@${intent.domain}`)) throw new Error('Некорректный новый адрес.');
  await reader.probe(result.address);
  accounts.push({ email: result.address, name: `Automation User ${index + 1}` });
  await fs.writeFile(`${manifest.directory}/issued.json`, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  console.log(`Новый ящик ${index + 1}/5 готов.`);
}
if (accounts.length !== 5 || new Set(accounts.map(row => row.email)).size !== 5) throw new Error('Нужны пять разных новых адресов.');
const accountsFile = `${manifest.directory}/accounts.jsonl`;
await fs.writeFile(accountsFile, accounts.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
manifest.accountsFile = accountsFile;
manifest.budgetFile = `${manifest.directory}/captcha-budget.json`;
await fs.writeFile(pointer, JSON.stringify(manifest, null, 2), { mode: 0o600 });
let env = await fs.readFile('.env', 'utf8');
for (const [key,value] of Object.entries({ ACCOUNTS_FILE: accountsFile, RUN_TARGET_TOKENS: '5', CAPTCHA_BUDGET_FILE: manifest.budgetFile, CAPTCHA_TOTAL_BUDGET_USD: '0.10' })) {
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  env = pattern.test(env) ? env.replace(pattern, () => key + '=' + value) : env.trimEnd() + '\n' + key + '=' + value + '\n';
}
await fs.writeFile('.env', env, { mode: 0o600 });
console.log(JSON.stringify({ ready: 5, directory: manifest.directory, previousTokensPreserved: manifest.previousTokens.length }));
