import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, readAccounts, validateConfig } from './config.js';
import { AppError } from './errors.js';
import { Vault } from './vault.js';
import { CaptchaSolver } from './captcha.js';
import { createMailbox } from './mail.js';
import { ApifyBrowser, loadSelectors, validateToken } from './browser.js';
import { chromiumRuntime, installBrowser } from './runtime.js';
import { PochtiReader } from './pochti.js';
import { makeRunPlan } from './run-plan.js';
import { CaptchaBudget } from './captcha-budget.js';

async function initialize() {
  let existing;
  try { existing = await readFile('.env', 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing === undefined) {
    const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    await writeFile('.env', example.replace('VAULT_KEY=', `VAULT_KEY=${randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
    console.log('Создан .env со случайным ключом шифрования.');
  } else console.log('.env уже существует, ключ не изменён.');
  try {
    await writeFile('accounts.jsonl', '{"email":"your-address@example.com"}\n', { flag: 'wx', mode: 0o600 });
    console.log('Создан accounts.jsonl.');
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  console.log('Настройки хранятся только локально. Перед запуском выполните npm run check.');
}

function assertReady(config, accounts) {
  const missing = validateConfig(config, accounts);
  if (missing.length) throw new AppError('SETUP_REQUIRED', `Заполните .env: ${missing.join('; ')}.`);
}

async function check(config) {
  const accounts = await readAccounts(config.accountsFile);
  assertReady(config, accounts);
  const balance = await new CaptchaSolver(config.captcha).balance();
  if (!(Number(balance) > 0)) throw new AppError('CAPTCHA_BALANCE', 'На балансе решателя нет средств.');
  console.log('Ключ решателя и ненулевой баланс подтверждены.');
  for (const [index, account] of accounts.entries()) {
    const mailbox = createMailbox(config.mail, account);
    try { await mailbox.connect(); console.log(`Ящик ${index + 1}: чтение доступно.`); }
    finally { await mailbox.close(); }
  }
  const chromium = await chromiumRuntime();
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  console.log(`Готово к запуску: ${accounts.length} адресов. Регистрации и платные CAPTCHA-задачи не выполнялись.`);
}

async function checkMail(config) {
  const accounts = await readAccounts(config.accountsFile);
  const missing = validateConfig(config, accounts, process.env, { mailOnly: true });
  if (missing.length) throw new AppError('SETUP_REQUIRED', missing.join('; '));
  for (const [index, account] of accounts.entries()) {
    const mailbox = createMailbox(config.mail, account);
    try {
      await mailbox.connect();
      const expiresAt = mailbox.metadata?.expiresAt;
      const formatted = expiresAt ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(expiresAt * 1000)) : '';
      const suffix = formatted ? ` Истекает: ${formatted} МСК.` : '';
      console.log(`Ящик ${index + 1}: подключение и чтение доступны.${suffix}`);
    } finally { await mailbox.close(); }
  }
  console.log('Почта проверена. Письма и состояние бота не изменялись.');
}

async function syncPochti(config, anchor) {
  if (config.mail.provider !== 'pochti') throw new AppError('POCHTI_CONFIG', 'Для синхронизации задайте MAIL_PROVIDER=pochti.');
  const email = anchor || config.mail.pochti.anchorEmail || (await readAccounts(config.accountsFile))[0].email;
  const rows = await new PochtiReader(config.mail.pochti).listAddresses(email);
  if (!Array.isArray(rows) || !rows.length) throw new AppError('POCHTI_EMPTY', 'У владельца указанного ящика нет активных адресов. Список не изменён.');
  const existing = await readAccounts(config.accountsFile).catch(async error => {
    try { await access(config.accountsFile); }
    catch (fileError) { if (fileError.code === 'ENOENT') return []; }
    throw error;
  });
  const byEmail = new Map(existing.map(row => [row.email, row]));
  const seen = new Set();
  const active = rows.map(row => {
    if (typeof row.address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.address) || !Number.isFinite(row.expires_at)) {
      throw new AppError('POCHTI_RESPONSE', 'Некорректный адрес в ответе сервера; список не изменён.');
    }
    const address = row.address.toLowerCase();
    if (seen.has(address)) throw new AppError('POCHTI_RESPONSE', 'Повтор адреса в ответе сервера; список не изменён.');
    seen.add(address);
    return { ...byEmail.get(address), email: address };
  });
  await mkdir(dirname(config.accountsFile), { recursive: true });
  const temp = `${config.accountsFile}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, active.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, config.accountsFile);
  console.log(`Импортировано активных адресов pochti: ${active.length}. Только адреса владельца исходного ящика. Сервер не изменён.`);
}

async function runAccount(browser, config, selectors, vault, account, index, budget) {
  let record = vault.get(account.email);
  if (record?.stage === 'done') { console.log(`Аккаунт ${index}: уже готов, пропущен.`); return; }
  // A captured token is always revalidated before doing any new UI work.
  if (record?.token) {
    const userId = await validateToken(record.token, account.email);
    await vault.set(account.email, { stage: 'done', userId, errorCode: null });
    console.log(`Аккаунт ${index}: сохранённый токен проверен.`);
    return;
  }
  if (record?.stage === 'token_creating') {
    throw new AppError('TOKEN_UNCERTAIN', 'Предыдущий запуск прерван при создании токена. Проверьте токены в Console; автоматический повтор исключён.');
  }
  if (!record) {
    await vault.set(account.email, { password: `Aa!${randomBytes(24).toString('base64url')}`, stage: 'prepared', errorCode: null });
    record = vault.get(account.email);
  }
  const mailbox = createMailbox(config.mail, account);
  let context;
  let page;
  try {
    // Check mailbox access before sending any registration request.
    await mailbox.connect();
    context = await browser.newContext({ locale: 'en-US', storageState: record.browserState || undefined });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(45000);
    const flow = new ApifyBrowser(page, selectors, new CaptchaSolver(config.captcha, { budget }));
    const resume = record.stage !== 'prepared';
    if (!resume) {
      await vault.set(account.email, { stage: 'signup_started', mailSince: Date.now(), errorCode: null });
      record = vault.get(account.email);
    }
    console.log(`Аккаунт ${index}: ${resume ? 'возобновление входа' : 'регистрация'}.`);
    const displayName = account.name || `Automation User ${index}`;
    let state;
    try { state = await flow.auth(account.email, record.password, { resume, displayName }); }
    catch (error) {
      if (error.code !== 'ACCOUNT_EXISTS') throw error;
      state = await flow.auth(account.email, record.password, { resume: true, displayName });
    }
    if (state === 'verification') {
      await vault.set(account.email, { stage: 'awaiting_email' });
      console.log(`Аккаунт ${index}: ожидание письма.`);
      const link = await mailbox.wait(record.mailSince || Date.now());
      const authenticated = await flow.verify(link);
      if (!authenticated) state = await flow.auth(account.email, record.password, { resume: true, displayName });
      else state = 'authenticated';
    }
    if (state !== 'authenticated') throw new AppError('EMAIL_UNCONFIRMED', 'Apify не подтвердил вход после проверки почты.');
    await vault.set(account.email, { stage: 'authenticated' });
    console.log(`Аккаунт ${index}: создание токена.`);
    const token = await flow.createToken(config.tokenDescription,
      () => vault.set(account.email, { stage: 'token_creating' }),
      token => vault.set(account.email, { stage: 'token_captured', token }),
    );
    const userId = await validateToken(token, account.email);
    await vault.set(account.email, { stage: 'done', userId, errorCode: null });
    console.log(`Аккаунт ${index}: готов, токен сохранён и проверен.`);
  } catch (error) {
    if (page) {
      if (page.url().startsWith('https://console.apify.com/') && !/\/sign-(?:up|in)/.test(page.url())) {
        const browserState = await context.storageState().catch(() => null);
        if (browserState) await vault.set(account.email, { browserState });
      }
      const scrub = text => String(text || '').replaceAll(record.password, '[PASSWORD]').replaceAll(config.captcha.apiKey, '[CAPTCHA_KEY]')
        .replace(/apify_api_[A-Za-z0-9_-]+/g, '[API_TOKEN]').replace(/https?:\/\/[^\s?]+\?[^\s]+/g, '[URL_WITH_QUERY]');
      const url = new URL(page.url());
      const diagnostic = {
        page: url.origin + url.pathname, stage: vault.get(account.email)?.stage,
        error: scrub(error.message),
        text: scrub(await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0,16000),
      };
      await mkdir('data/debug', { recursive: true });
      await writeFile(`data/debug/account-${index}.json`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
      if (['prepared', 'signup_started', 'awaiting_email'].includes(diagnostic.stage)) {
        await page.screenshot({ path: `data/debug/account-${index}.jpg` }).catch(() => {});
      }
    }
    throw error;
  } finally {
    await context?.close();
    await mailbox.close();
  }
}

async function run(config, vault) {
  const accounts = await readAccounts(config.accountsFile);
  assertReady(config, accounts);
  const plan = makeRunPlan(accounts, vault.records, config.targetTokens || accounts.length);
  if (!plan.remaining) { console.log(`Цель уже достигнута: ${plan.ready}/${plan.target} проверенных токенов.`); return; }
  console.log(`Цель: ${plan.target} токенов; уже сохранено: ${plan.ready}.`);
  const selectors = await loadSelectors(config.selectorsFile);
  const budget = config.captcha.budgetUsd ? new CaptchaBudget(config.captcha.budgetFile, config.captcha.budgetUsd) : null;
  if (budget) await budget.load();
  if (!(Number(await new CaptchaSolver(config.captcha).balance()) > 0)) throw new AppError('CAPTCHA_BALANCE', 'На балансе решателя нет средств.');
  const chromium = await chromiumRuntime();
  const browser = await chromium.launch({ headless: config.headless });
  let failed = 0;
  let attempted = 0;
  let ready = plan.ready;
  try {
    for (const [offset, account] of plan.candidates.entries()) {
      if (ready >= plan.target) break;
      attempted++;
      try {
        await runAccount(browser, config, selectors, vault, account, offset + 1, budget);
        if (vault.get(account.email)?.stage === 'done' && vault.get(account.email)?.token) ready++;
      }
      catch (error) {
        failed++;
        const code = error instanceof AppError ? error.code : 'AUTOMATION_ERROR';
        await vault.set(account.email, { errorCode: code });
        console.error(`Аккаунт ${offset + 1}: ${code}. ${error instanceof AppError ? error.message : 'Проверьте интерфейс Apify и настройки селекторов.'}`);
      }
    }
  } finally { await browser.close(); }
  if (ready < plan.target) process.exitCode = 1;
  console.log(`Проверенные токены: ${ready}/${plan.target}; попыток: ${attempted}; ошибок: ${failed}. Токены в зашифрованном хранилище.`);
}

async function withVault(config, operation) {
  const vault = new Vault(config.vaultFile, config.vaultKey);
  await vault.lock();
  try { await vault.load(); await operation(vault); }
  finally { await vault.unlock(); }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'help';
  if (command === 'init') return initialize();
  if (command === 'install-browser') return installBrowser();
  if (command === 'help') {
    console.log('Команды: init, install-browser, check, check-mail, sync-mail [исходный-email], run, status, export <file.json>, retry-signup <email>'); return;
  }
  const config = getConfig();
  if (command === 'check-mail') return checkMail(config);
  if (command === 'sync-mail') return syncPochti(config, args[1]);
  if (command === 'check') return check(config);
  if (!['run', 'status', 'export', 'retry-signup'].includes(command)) throw new AppError('COMMAND', 'Неизвестная команда.');
  await withVault(config, async vault => {
    if (command === 'run') return run(config, vault);
    if (command === 'status') {
      const rows = Object.entries(vault.records).map(([email, r]) => ({ email, stage: r.stage, hasToken: Boolean(r.token), error: r.errorCode || '', updatedAt: r.updatedAt }));
      console.table(rows); return;
    }
    if (command === 'retry-signup') {
      const email = args[1]?.toLowerCase();
      const record = vault.get(email);
      if (!record || record.token || record.stage === 'token_creating') throw new AppError('RESET_DENIED', 'Разрешён повтор только незавершённой регистрации без токена.');
      await vault.set(email, { stage: 'prepared', errorCode: null });
      console.log('Следующий запуск повторит регистрацию с тем же сохранённым паролем.'); return;
    }
    if (!args[1]) throw new AppError('EXPORT_FILE', 'Укажите новый путь для экспорта JSON.');
    const file = resolve(args[1]);
    if (file === resolve(config.vaultFile)) throw new AppError('EXPORT_FILE', 'Нельзя перезаписать хранилище.');
    const rows = Object.entries(vault.records).filter(([, r]) => r.stage === 'done').map(([email, r]) => ({ email, apiToken: r.token, userId: r.userId }));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(rows, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`Экспортировано записей: ${rows.length}. Файл содержит незашифрованные токены.`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'Ошибка выполнения; проверьте файлы настроек, зависимости и соединение.');
    process.exitCode = 1;
  });
}
