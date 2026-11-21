import { AppError, delay, jsonRequest } from './errors.js';
import { PochtiMailbox } from './pochti.js';

function addresses(value) {
  return String(value || '').toLowerCase().match(/[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}/gi) || [];
}

export function verificationLink(message, email, since) {
  const received = Date.parse(message.date);
  if (!Number.isFinite(received) || received < since - 60000) return null;
  if (!addresses(message.to).includes(email.toLowerCase())) return null;
  if (!addresses(message.from).some(a => /@(?:[a-z\d-]+\.)*apify\.com$/i.test(a))) return null;
  const content = `${message.text || ''}\n${message.html || ''}`.replace(/&amp;/gi, '&');
  const links = content.match(/https:\/\/[^\s<>"'\[\]]+/g) || [];
  for (const raw of links) {
    try {
      const url = new URL(raw.replace(/[).,;]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) continue;
      if (!['console.apify.com', 'api.apify.com'].includes(url.hostname)) continue;
      if (!/(?:verif|confirm|sign-up)/i.test(url.pathname)) continue;
      return url.href;
    } catch { /* Ignore invalid links. */ }
  }
  return null;
}

export class HttpMailbox {
  constructor(config, email, { fetcher = fetch, sleep = delay, now = Date.now } = {}) {
    this.config = config; this.email = email;
    this.fetcher = fetcher; this.sleep = sleep; this.now = now;
  }
  async messages() {
    const headers = { Accept: 'application/json' };
    if (this.config.apiToken) headers.Authorization = `Bearer ${this.config.apiToken}`;
    const data = await jsonRequest(this.config.apiUrl.replaceAll('{email}', encodeURIComponent(this.email)), { headers }, this.fetcher);
    const messages = Array.isArray(data) ? data : data.messages;
    if (!Array.isArray(messages)) throw new AppError('MAIL_SCHEMA', 'HTTP API должен возвращать массив messages.');
    return messages;
  }
  async connect() { await this.messages(); }
  async close() {}
  async wait(since) {
    const deadline = this.now() + this.config.timeoutMs;
    while (this.now() < deadline) {
      for (const message of await this.messages()) {
        const link = verificationLink(message, this.email, since);
        if (link) return link;
      }
      await this.sleep(this.config.pollMs);
    }
    throw new AppError('MAIL_TIMEOUT', 'Не получено подходящее письмо подтверждения Apify.');
  }
}

export class ImapMailbox {
  constructor(config, account, env = process.env) {
    this.config = config; this.account = account;
    this.password = account.mailPasswordEnv ? env[account.mailPasswordEnv] : config.password;
  }
  async connect() {
    const { ImapFlow } = await import('imapflow');
    this.client = new ImapFlow({
      host: this.config.host, port: this.config.port, secure: true,
      auth: { user: this.account.mailUser || this.config.user || this.account.email, pass: this.password },
      logger: false, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    // Never emit raw protocol errors: they may contain mailbox identifiers.
    this.client.on('error', () => {});
    try {
      await this.client.connect();
      await this.client.mailboxOpen(this.config.folder, { readOnly: true });
    } catch {
      this.client.close();
      throw new AppError('MAIL_CONNECT', 'Не удалось подключиться к IMAP: проверьте сервер, TLS и данные входа.');
    }
  }
  async close() {
    if (this.client?.usable) await this.client.logout().catch(() => this.client.close());
    else this.client?.close();
  }
  async wait(since) {
    const { simpleParser } = await import('mailparser');
    const deadline = Date.now() + this.config.timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      try {
        await this.client.noop();
        const uids = await this.client.search({ since: new Date(since - 60000) }, { uid: true });
        for (const uid of uids.slice(-100).reverse()) {
          if (seen.has(uid)) continue;
          const item = await this.client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
          if (!item?.source) continue;
          const parsed = await simpleParser(item.source);
          const to = [parsed.to?.text, parsed.headers.get('delivered-to'), parsed.headers.get('x-original-to')].join(' ');
          const link = verificationLink({
            date: (item.internalDate || parsed.date)?.toISOString(),
            from: parsed.from?.text, to, text: parsed.text, html: parsed.html,
          }, this.account.email, since);
          seen.add(uid);
          if (link) return link;
        }
      } catch { throw new AppError('MAIL_READ', 'Ошибка чтения IMAP. Повторный запуск продолжит вход в уже созданный аккаунт.'); }
      await delay(this.config.pollMs);
    }
    throw new AppError('MAIL_TIMEOUT', 'Не получено подходящее письмо подтверждения Apify.');
  }
}

export function createMailbox(config, account) {
  if (config.provider === 'pochti') return new PochtiMailbox(config, account.email, verificationLink);
  return config.provider === 'http' ? new HttpMailbox(config, account.email) : new ImapMailbox(config, account);
}
