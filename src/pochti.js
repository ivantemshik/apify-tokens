import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AppError, delay } from './errors.js';

const messages = {
  MAIL_NOT_FOUND: 'Ящик не найден в pochti. Возможно, его срок истёк и он уже удалён.',
  MAIL_EXPIRED: 'Срок действия ящика pochti истёк.',
  MAIL_CONFIG: 'Не удалось прочитать конфигурацию базы pochti.',
  MAIL_REMOTE_READ: 'Не удалось прочитать почтовую базу pochti.',
  MAIL_ISSUE_UNAVAILABLE: 'Штатная выдача нового ящика pochti недоступна; существующие адреса не использовались.',
  MAIL_OWNER_UNRESOLVED: 'Не удалось однозначно определить владельца прежних ящиков pochti.',
};

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function sshArguments(config, script) {
  if (!/^[a-z_][a-z\d_-]*@[a-z\d.-]+$/i.test(config.sshHost)) throw new AppError('POCHTI_CONFIG', 'Некорректный POCHTI_SSH_HOST.');
  const source = Buffer.from(script, 'utf8').toString('base64');
  const bootstrap = `import base64;exec(compile(base64.b64decode("${source}"),"<apify-readonly-mail>","exec"))`;
  return [
    '-T', '-i', resolve(config.sshKey), '-p', String(config.sshPort),
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', `UserKnownHostsFile=${resolve(config.knownHosts)}`,
    '-o', 'ConnectTimeout=10', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'KexAlgorithms=curve25519-sha256',
    config.sshHost, `python3 -B -c ${shellQuote(bootstrap)}`,
  ];
}

export function runSsh(config, script, request, spawnProcess = spawn) {
  const args = sshArguments(config, script);
  return new Promise((done, reject) => {
    const child = spawnProcess(config.sshExecutable || 'ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else done(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new AppError('POCHTI_SSH_TIMEOUT', 'SSH-соединение с почтой не завершилось за 25 секунд.'));
    }, 25000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 32 * 1024 * 1024) {
        child.kill(); finish(new AppError('POCHTI_RESPONSE_LIMIT', 'Ответ почтового сервера слишком большой.')); return;
      }
      chunks.push(chunk);
    });
    // Drain but never print diagnostics that might contain environment details.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new AppError('POCHTI_SSH', 'Не удалось запустить SSH-клиент.')));
    child.on('close', code => {
      if (finished) return;
      if (code !== 0) return finish(new AppError('POCHTI_SSH', 'SSH отклонил подключение. Проверьте ключ и доверенный отпечаток сервера.'));
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(new AppError('POCHTI_RESPONSE', 'Почтовый сервер вернул некорректный JSON.')); }
      if (!result.ok) {
        const code = Object.hasOwn(messages, result.error) ? result.error : 'MAIL_REMOTE_READ';
        return finish(new AppError(code, messages[code]));
      }
      finish(null, result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class PochtiReader {
  constructor(config, { execute = runSsh } = {}) { this.config = config; this.execute = execute; }
  async request(action, email, since = 0) {
    const script = await readFile(new URL('../scripts/pochti-reader.py', import.meta.url), 'utf8');
    return this.execute(this.config, script, { action, email, since, config: this.config.remoteConfig });
  }
  async checkFiles() {
    try { await access(this.config.sshKey); await access(this.config.knownHosts); }
    catch { throw new AppError('POCHTI_FILES', 'Не найден SSH-ключ или known_hosts из pochti.'); }
  }
  async probe(email) { await this.checkFiles(); return this.request('probe', email); }
  async listAddresses(email) { await this.checkFiles(); return (await this.request('addresses', email)).addresses; }
}

export class PochtiMailbox {
  constructor(config, email, findVerificationLink, { reader = new PochtiReader(config.pochti), sleep = delay, now = Date.now } = {}) {
    this.config = config; this.email = email; this.reader = reader;
    this.findLink = findVerificationLink; this.sleep = sleep; this.now = now;
  }
  async connect() { this.metadata = (await this.reader.probe(this.email)).mailbox; }
  async close() {}
  async wait(since) {
    const deadline = this.now() + this.config.timeoutMs;
    while (this.now() < deadline) {
      const result = await this.reader.request('messages', this.email, since);
      if (!Array.isArray(result.messages)) throw new AppError('POCHTI_RESPONSE', 'Нет списка писем в ответе pochti.');
      for (const row of result.messages) {
        const link = this.findLink({
          to: this.email, from: row.sender, date: new Date(row.received_at * 1000).toISOString(), text: row.body,
        }, this.email, since);
        if (link) return link;
      }
      await this.sleep(this.config.pollMs);
    }
    throw new AppError('MAIL_TIMEOUT', 'Письмо Apify не поступило в pochti за отведённое время.');
  }
}
