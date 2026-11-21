import { AppError, delay, jsonRequest } from './errors.js';

export function buildTask(provider, challenge) {
  if (!challenge.siteKey || !challenge.websiteURL) throw new AppError('CAPTCHA_PARAMETERS', 'Не найдены параметры reCAPTCHA.');
  if (challenge.version && challenge.version !== 'v2') throw new AppError('CAPTCHA_UNSUPPORTED', 'Этот адаптер поддерживает reCAPTCHA v2 / v2 Enterprise.');
  const enterprise = Boolean(challenge.enterprise);
  const type = provider === 'capsolver'
    ? (enterprise ? 'ReCaptchaV2EnterpriseTaskProxyLess' : 'ReCaptchaV2TaskProxyLess')
    : (enterprise ? 'RecaptchaV2EnterpriseTaskProxyless' : 'RecaptchaV2TaskProxyless');
  const task = { type, websiteURL: challenge.websiteURL, websiteKey: challenge.siteKey, isInvisible: Boolean(challenge.invisible) };
  if (challenge.dataS) {
    if (enterprise) task.enterprisePayload = { s: challenge.dataS };
    else task.recaptchaDataSValue = challenge.dataS;
  }
  if (provider === 'capsolver' && challenge.action) task.pageAction = challenge.action;
  return task;
}

export class CaptchaSolver {
  constructor(config, { fetcher = fetch, sleep = delay, now = Date.now, budget = null } = {}) {
    if (!['capsolver', '2captcha'].includes(config.provider)) throw new AppError('CAPTCHA_PROVIDER', 'Неизвестный решатель.');
    this.config = config;
    this.fetcher = fetcher; this.sleep = sleep; this.now = now;
    this.base = config.provider === 'capsolver' ? 'https://api.capsolver.com' : 'https://api.2captcha.com';
    this.tasks = 0;
    this.budget = budget;
  }
  async call(method, body) {
    let result;
    try {
      result = await jsonRequest(`${this.base}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.config.apiKey, ...body }),
      }, this.fetcher);
    } catch (error) {
      if (error.serviceCode) throw this.providerError(error.serviceCode);
      throw error;
    }
    if (result.errorId) {
      const code = /^[A-Z_\d]+$/.test(result.errorCode) ? result.errorCode : 'PROVIDER_ERROR';
      throw this.providerError(code);
    }
    return result;
  }
  providerError(code) {
    const message = code === 'ERROR_KEY_DENIED_ACCESS'
      ? 'CapSolver не разрешил доступ: проверьте API-ключ и доступный баланс в кабинете.'
      : 'Решатель отклонил запрос; проверьте ключ, баланс и параметры.';
    return new AppError(`CAPTCHA_${code}`, message);
  }
  async balance() { return (await this.call('getBalance', {})).balance; }
  async solve(challenge) {
    if (this.tasks >= this.config.maxTasks) throw new AppError('CAPTCHA_BUDGET', 'Достигнут лимит платных задач для аккаунта.');
    const task = buildTask(this.config.provider, challenge);
    const reservation = this.budget ? await this.budget.reserve() : null;
    this.tasks++;
    // Do not retry createTask: a timeout can occur after a paid task was created.
    let result = await this.call('createTask', { task });
    const taskId = result.taskId;
    const deadline = this.now() + this.config.timeoutMs;
    while (result.status !== 'ready') {
      if (!taskId) throw new AppError('CAPTCHA_RESPONSE', 'Решатель не вернул taskId.');
      if (this.now() >= deadline) throw new AppError('CAPTCHA_TIMEOUT', 'Решатель не ответил за отведённое время.');
      await this.sleep(5000);
      result = await this.call('getTaskResult', { taskId });
      if (result.status && !['processing', 'ready'].includes(result.status)) {
        throw new AppError('CAPTCHA_RESPONSE', 'Неизвестный статус решателя.');
      }
    }
    const token = result.solution?.gRecaptchaResponse || result.solution?.token;
    if (typeof token !== 'string' || !token) throw new AppError('CAPTCHA_RESPONSE', 'Ответ решателя не содержит токен.');
    if (this.budget) await this.budget.settle(reservation, result.cost);
    return token;
  }
}
