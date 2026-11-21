import { readFile } from 'node:fs/promises';
import { AppError } from './errors.js';
import { join } from 'node:path';

function number(env, name, fallback, min = 1, max = 3600000) {
  const result = Number(env[name] || fallback);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new AppError('CONFIG', `Некорректное значение ${name}.`);
  }
  return result;
}

export function getConfig(env = process.env) {
  if (env.HEADLESS && !['true', 'false'].includes(env.HEADLESS)) {
    throw new AppError('CONFIG', 'HEADLESS должен быть true или false.');
  }
  const pochtiProject = env.POCHTI_PROJECT || 'C:/Users/user/Desktop/pochti';
  return {
    vaultKey: env.VAULT_KEY || '', vaultFile: env.VAULT_FILE || 'data/accounts.vault.json',
    accountsFile: env.ACCOUNTS_FILE || 'accounts.jsonl', headless: env.HEADLESS !== 'false',
    selectorsFile: env.SELECTORS_FILE || '', tokenDescription: env.TOKEN_DESCRIPTION || 'local-automation',
    targetTokens: env.RUN_TARGET_TOKENS ? number(env, 'RUN_TARGET_TOKENS', 5, 1, 1000) : null,
    captcha: {
      provider: env.CAPTCHA_PROVIDER || 'capsolver', apiKey: env.CAPTCHA_API_KEY || '',
      timeoutMs: number(env, 'CAPTCHA_TIMEOUT_MS', 180000),
      maxTasks: number(env, 'MAX_CAPTCHA_TASKS_PER_ACCOUNT', 2, 1, 10),
      budgetUsd: env.CAPTCHA_TOTAL_BUDGET_USD || '',
      budgetFile: env.CAPTCHA_BUDGET_FILE || 'data/captcha-budget.json',
    },
    mail: {
      provider: env.MAIL_PROVIDER || 'imap', host: env.IMAP_HOST || '',
      port: number(env, 'IMAP_PORT', 993, 1, 65535), folder: env.IMAP_FOLDER || 'INBOX',
      user: env.IMAP_USER || '', password: env.MAIL_PASSWORD || '',
      apiUrl: env.MAIL_API_URL || '', apiToken: env.MAIL_API_TOKEN || '',
      timeoutMs: number(env, 'MAIL_TIMEOUT_MS', 180000), pollMs: number(env, 'MAIL_POLL_MS', 5000, 100),
      pochti: {
        project: pochtiProject,
        anchorEmail: env.POCHTI_ANCHOR_EMAIL || '',
        sshExecutable: env.POCHTI_SSH_EXE || 'ssh',
        sshHost: env.POCHTI_SSH_HOST || 'root@mail.example.com',
        sshPort: number(env, 'POCHTI_SSH_PORT', 22, 1, 65535),
        sshKey: env.POCHTI_SSH_KEY || join(pochtiProject, '.secrets', 'sprintbox-maintenance'),
        knownHosts: env.POCHTI_KNOWN_HOSTS || join(pochtiProject, '.secrets', 'sprintbox-known-hosts'),
        remoteConfig: env.POCHTI_REMOTE_CONFIG || '/etc/tempmail/config.json',
      },
    },
  };
}

export async function readAccounts(file) {
  const source = await readFile(file, 'utf8').catch(() => {
    throw new AppError('ACCOUNTS_FILE', 'Нет файла accounts.jsonl; выполните npm run init.');
  });
  const accounts = [];
  const seen = new Set();
  for (const [i, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new AppError('ACCOUNTS_FILE', `Неверный JSON в строке ${i + 1}.`); }
    if (typeof row.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      throw new AppError('ACCOUNTS_FILE', `Неверный email в строке ${i + 1}.`);
    }
    row.email = row.email.trim().toLowerCase();
    if (seen.has(row.email)) throw new AppError('ACCOUNTS_FILE', `Повтор email в строке ${i + 1}.`);
    seen.add(row.email);
    accounts.push(row);
  }
  if (!accounts.length) throw new AppError('ACCOUNTS_FILE', 'Список адресов пуст.');
  return accounts;
}

export function validateConfig(config, accounts, env = process.env, { mailOnly = false } = {}) {
  const missing = [];
  if (!mailOnly) {
    if (!/^[a-f\d]{64}$/i.test(config.vaultKey)) missing.push('VAULT_KEY (64 hex-символа; создаётся init)');
    if (!['capsolver', '2captcha'].includes(config.captcha.provider)) missing.push('CAPTCHA_PROVIDER=capsolver или 2captcha');
    if (!config.captcha.apiKey) missing.push('CAPTCHA_API_KEY');
  }
  if (config.mail.provider === 'imap') {
    if (!config.mail.host) missing.push('IMAP_HOST');
    if (accounts.some(a => !(a.mailPasswordEnv ? env[a.mailPasswordEnv] : config.mail.password))) {
      missing.push('MAIL_PASSWORD либо переменная mailPasswordEnv для каждого ящика');
    }
  } else if (config.mail.provider === 'http') {
    try {
      if (!config.mail.apiUrl.includes('{email}')) throw new Error();
      const url = new URL(config.mail.apiUrl.replace('{email}', 'test%40example.com'));
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    } catch { missing.push('MAIL_API_URL (HTTPS URL с {email}, без пароля в URL)'); }
  } else if (config.mail.provider === 'pochti') {
    if (!/^[a-z_][a-z\d_-]*@[a-z\d.-]+$/i.test(config.mail.pochti.sshHost)) missing.push('POCHTI_SSH_HOST (user@host)');
    if (!config.mail.pochti.remoteConfig.startsWith('/')) missing.push('POCHTI_REMOTE_CONFIG (абсолютный путь)');
  } else missing.push('MAIL_PROVIDER=imap, http или pochti');
  return missing;
}
