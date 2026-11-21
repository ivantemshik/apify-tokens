import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export function dollarMicros(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new AppError('CAPTCHA_COST', 'Некорректная сумма в бюджете CAPTCHA.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(amount)) throw new AppError('CAPTCHA_COST', 'Сумма CAPTCHA слишком велика.');
  return amount;
}

// The CLI holds the vault lock throughout a run, including all budget writes.
export class CaptchaBudget {
  constructor(file, limitUsd) { this.file = file; this.limitMicros = dollarMicros(limitUsd); this.entries = []; }
  async load() {
    let source;
    try { source = await readFile(this.file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let data;
    try { data = JSON.parse(source); } catch { throw new AppError('CAPTCHA_LEDGER', 'Повреждён журнал бюджета CAPTCHA.'); }
    if (data.version !== 1 || data.limitMicros !== this.limitMicros || !Array.isArray(data.entries)
      || data.entries.some(row => typeof row.id !== 'string' || row.reservedMicros !== 10000 || (row.costMicros !== null && (!Number.isSafeInteger(row.costMicros) || row.costMicros < 0)))) {
      throw new AppError('CAPTCHA_LEDGER', 'Журнал CAPTCHA не соответствует текущему бюджету.');
    }
    this.entries = data.entries;
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, limitMicros: this.limitMicros, entries: this.entries }, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
  async reserve() {
    // Reserve $0.01 for each v2 task, above the published 2Captcha v2 price.
    // Reservations survive failures and restarts and are never reused.
    const reserved = this.entries.reduce((sum, row) => sum + row.reservedMicros, 0);
    if (reserved + 10000 > this.limitMicros) throw new AppError('CAPTCHA_TOTAL_BUDGET', 'Общий лимит задач CAPTCHA исчерпан; повторная оплата остановлена.');
    const entry = { id: randomUUID(), reservedMicros: 10000, costMicros: null, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    await this.save();
    return entry.id;
  }
  async settle(id, cost) {
    const entry = this.entries.find(row => row.id === id);
    if (!entry) throw new AppError('CAPTCHA_LEDGER', 'Не найдена запись оплачиваемой задачи.');
    if (cost !== undefined) entry.costMicros = dollarMicros(cost);
    await this.save();
    if (entry.costMicros > entry.reservedMicros) throw new AppError('CAPTCHA_PRICE_LIMIT', 'Стоимость задачи превысила резерв; дальнейшая оплата остановлена.');
  }
}
