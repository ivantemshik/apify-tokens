import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getConfig, readAccounts } from '../src/config.js';
import { Vault } from '../src/vault.js';
import { validateToken } from '../src/browser.js';

const config = getConfig();
const accounts = await readAccounts(config.accountsFile);
const vault = new Vault(config.vaultFile, config.vaultKey);
await vault.load();
if (accounts.length !== 5) throw new Error('Финальная проверка требует ровно пять выбранных аккаунтов.');
const records = accounts.map(account => ({ email: account.email, ...vault.get(account.email) }));
if (records.some(row => row.stage !== 'done' || !row.token)) throw new Error('Ещё не сохранены все пять токенов.');
const results = await Promise.allSettled(records.map(async row => ({
  email: row.email,
  userId: await validateToken(row.token, row.email),
  tokenFingerprint: createHash('sha256').update(row.token).digest('hex').slice(0,16),
})));
if (results.some(row => row.status !== 'fulfilled')) throw new Error('Не все пять токенов прошли повторную проверку через Apify API.');
const verified = results.map(row => row.value);
if (new Set(verified.map(row => row.userId)).size !== 5 || new Set(verified.map(row => row.tokenFingerprint)).size !== 5) {
  throw new Error('Токены должны принадлежать пяти разным аккаунтам.');
}
await fs.mkdir('exports', { recursive: true });
const exportFile = 'exports/apify-tokens.json';
const exported = records.map((row, index) => ({ email: row.email, apiToken: row.token, userId: verified[index].userId }));
try { await fs.writeFile(exportFile, JSON.stringify(exported, null, 2), { flag: 'wx', mode: 0o600 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = JSON.parse(await fs.readFile(exportFile, 'utf8'));
  if (JSON.stringify(existing) !== JSON.stringify(exported)) throw new Error('Существующий экспорт отличается; файл не перезаписан.');
}
const budget = JSON.parse(await fs.readFile(config.captcha.budgetFile, 'utf8'));
const reservedMicros = budget.entries.reduce((sum, row) => sum + row.reservedMicros, 0);
if (reservedMicros > budget.limitMicros) throw new Error('Резерв бюджета превысил установленный лимит.');
const report = {
  target: 5, verified: verified.length, uniqueUsers: 5,
  verifiedAt: new Date().toISOString(), exportFile: resolve(exportFile), tokens: verified,
  captcha: { reservedTasks: budget.entries.length, reservedUsd: reservedMicros / 1000000, knownCostUsd: budget.entries.reduce((sum,row) => sum + (row.costMicros || 0),0) / 1000000, unknownCostTasks: budget.entries.filter(row => row.costMicros === null).length },
};
await fs.writeFile('data/production-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ verified: 5, uniqueAccounts: 5, exportFile: resolve(exportFile), tokensPrinted: false }));
