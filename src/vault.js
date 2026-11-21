import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from './errors.js';

export class Vault {
  constructor(file, keyHex) {
    if (!/^[a-f\d]{64}$/i.test(keyHex)) throw new AppError('VAULT_KEY', 'Некорректный VAULT_KEY.');
    this.file = file;
    this.key = Buffer.from(keyHex, 'hex');
    this.records = {};
  }
  async lock() {
    await mkdir(dirname(this.file), { recursive: true });
    try { this.lockHandle = await open(`${this.file}.lock`, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new AppError('VAULT_LOCKED', 'Другой процесс использует хранилище; после аварийного завершения удалите .lock вручную.');
      throw e;
    }
    await this.lockHandle.writeFile(String(process.pid));
  }
  async unlock() {
    if (!this.lockHandle) return;
    await this.lockHandle.close();
    this.lockHandle = null;
    await unlink(`${this.file}.lock`);
  }
  async load() {
    let source;
    try { source = await readFile(this.file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      const data = JSON.parse(source);
      if (data.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'base64'));
      decipher.setAAD(Buffer.from('apify-account-vault:v1'));
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      this.records = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(data.payload, 'base64')), decipher.final(),
      ]).toString('utf8'));
    } catch { throw new AppError('VAULT_DECRYPT', 'Хранилище повреждено или VAULT_KEY не совпадает.'); }
  }
  get(email) { return this.records[email]; }
  async set(email, changes) {
    if (!this.lockHandle) throw new AppError('VAULT_UNLOCKED', 'Нет блокировки хранилища.');
    this.records[email] = { ...this.records[email], ...changes, updatedAt: new Date().toISOString() };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('apify-account-vault:v1'));
    const payload = Buffer.concat([cipher.update(JSON.stringify(this.records), 'utf8'), cipher.final()]);
    const data = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), payload: payload.toString('base64') };
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, this.file);
  }
}
