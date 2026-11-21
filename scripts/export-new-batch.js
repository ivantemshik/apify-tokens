import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getConfig, readAccounts } from '../src/config.js';
import { Vault } from '../src/vault.js';
import { validateToken } from '../src/browser.js';

const config = getConfig();
const manifest = JSON.parse(await fs.readFile('data/current-new-batch.json', 'utf8'));
if (manifest.accountsFile !== config.accountsFile) throw new Error('В конфигурации выбран другой прогон.');
const accounts = await readAccounts(config.accountsFile);
const vault = new Vault(config.vaultFile, config.vaultKey);
await vault.load();
const records = accounts.map(account => ({ email: account.email, ...vault.get(account.email) }));
if (records.length !== 5 || records.some(row => row.stage !== 'done' || !row.token)) throw new Error('Пока не готовы все пять новых токенов.');
const previous = JSON.parse(await fs.readFile('exports/apify-tokens.json', 'utf8'));
const previousUserIds = new Set(previous.map(row => row.userId));
const fingerprints = records.map(row => createHash('sha256').update(row.token).digest('hex'));
if (fingerprints.some(hash => manifest.previousTokens.includes(hash))) throw new Error('Новый экспорт содержит токен из предыдущего прогона.');
const checks = await Promise.allSettled(records.map(async row => ({ email: row.email, apiToken: row.token, userId: await validateToken(row.token, row.email) })));
if (checks.some(row => row.status !== 'fulfilled')) throw new Error('Повторная проверка не подтвердила все пять токенов.');
const verified = checks.map(row => row.value);
if (new Set(verified.map(row => row.userId)).size !== 5 || verified.some(row => previousUserIds.has(row.userId))) throw new Error('Требуются пять новых разных аккаунтов.');
const vaultPrevious = Object.values(vault.records).filter(row => row.stage === 'done' && row.token).map(row => createHash('sha256').update(row.token).digest('hex'));
if (manifest.previousTokens.some(hash => !vaultPrevious.includes(hash))) throw new Error('Не все предыдущие токены найдены в хранилище.');
const suffix = manifest.directory.split('/').at(-1);
const jsonFile = `exports/apify-tokens-${suffix}.json`;
const txtFile = `exports/apify-tokens-${suffix}.txt`;
await fs.mkdir('exports', { recursive: true });
async function writeNew(file, content) {
  try { await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await fs.readFile(file, 'utf8') !== content) throw new Error('Существующий экспорт не совпадает; перезапись остановлена.');
  }
}
await writeNew(jsonFile, JSON.stringify(verified, null, 2));
await writeNew(txtFile, verified.map(row => row.apiToken).join('\n') + '\n');
let budget;
try { budget = JSON.parse(await fs.readFile(manifest.budgetFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; budget = { limitMicros: 100000, entries: [] }; }
const reservedMicros = budget.entries.reduce((sum,row) => sum + row.reservedMicros, 0);
if (reservedMicros > budget.limitMicros) throw new Error('Превышен лимит резерва CAPTCHA.');
const report = {
  target: 5, verified: 5, uniqueNewAccounts: 5, previousTokensPreserved: manifest.previousTokens.length,
  verifiedAt: new Date().toISOString(), files: { txt: resolve(txtFile), json: resolve(jsonFile) },
  tokens: verified.map((row,index) => ({ email: row.email, userId: row.userId, fingerprint: fingerprints[index] })),
  captcha: { tasks: budget.entries.length, knownCostUsd: budget.entries.reduce((sum,row) => sum + (row.costMicros || 0),0) / 1000000, unknownCosts: budget.entries.filter(row => row.costMicros === null).length },
};
await fs.writeFile(`${manifest.directory}/verification.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
manifest.complete = true;
manifest.exportFiles = report.files;
await fs.writeFile('data/current-new-batch.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ verified: 5, uniqueNewAccounts: 5, previousPreserved: manifest.previousTokens.length, files: report.files, captcha: report.captcha, tokensPrinted: false }));
