import { readFile } from 'node:fs/promises';
import { AppError, delay, jsonRequest } from './errors.js';

export const defaultSelectors = {
  email: 'input[type="email"], input[name="email"]',
  password: 'input[type="password"]',
  name: 'input[name="name"], input[name="fullName"], input[name="full_name"], input[autocomplete="name"], input[placeholder*="name" i]',
  next: 'button:has-text("Next")',
  signup: 'button:has-text("Sign up"), button:has-text("Create account")',
  login: 'button:has-text("Log in"), button:has-text("Sign in")',
  verificationText: 'Check your email|verification email|verify your email|confirm your email',
  newToken: 'button:has-text("Create a new token")',
  tokenDialog: '[role="dialog"]',
  tokenDescription: 'input[name="description"], input[placeholder*="description" i]',
  createToken: 'button:text-is("Create")',
  integrationsUrl: 'https://console.apify.com/settings/integrations',
};

export async function loadSelectors(file) {
  if (!file) return { ...defaultSelectors };
  let extra;
  try { extra = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new AppError('SELECTORS', 'Не удалось прочитать SELECTORS_FILE.'); }
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in defaultSelectors) || typeof value !== 'string') throw new AppError('SELECTORS', 'Неизвестный или некорректный селектор.');
  }
  const result = { ...defaultSelectors, ...extra };
  const url = new URL(result.integrationsUrl);
  if (url.origin !== 'https://console.apify.com') throw new AppError('SELECTORS', 'Настройки токенов должны открываться на console.apify.com.');
  return result;
}

// Runs only in the automation browser, and returns public challenge parameters.
export function detectRecaptcha() {
  const anchor = [...document.querySelectorAll('iframe[src]')].find(el => /\/(api2|enterprise)\/anchor/.test(el.src));
  const widget = document.querySelector('.g-recaptcha[data-sitekey]');
  if (!anchor && !widget) return null;
  const url = anchor ? new URL(anchor.src) : null;
  const siteKey = widget?.getAttribute('data-sitekey') || url?.searchParams.get('k');
  if (!siteKey) return null;
  return {
    version: 'v2', siteKey, websiteURL: location.href,
    enterprise: Boolean(url?.pathname.includes('/enterprise/') || document.querySelector('script[src*="recaptcha/enterprise.js"]')),
    invisible: (widget?.getAttribute('data-size') || url?.searchParams.get('size')) === 'invisible',
    dataS: widget?.getAttribute('data-s') || url?.searchParams.get('s') || '',
    action: url?.searchParams.get('sa') || '',
    id: anchor?.src || siteKey,
  };
}

export function applyRecaptchaToken(input) {
  const token = typeof input === 'string' ? input : input.token;
  const siteKey = typeof input === 'string' ? null : input.siteKey;
  const fields = [...document.querySelectorAll('textarea[name="g-recaptcha-response"]')];
  for (const field of fields) {
    field.value = token;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const callbacks = new Set();
  for (const el of document.querySelectorAll('[data-callback]')) {
    if (siteKey && el.getAttribute('data-sitekey') && el.getAttribute('data-sitekey') !== siteKey) continue;
    const path = el.getAttribute('data-callback').split('.');
    let fn = window;
    for (const part of path) fn = fn?.[part];
    if (typeof fn === 'function') callbacks.add(fn);
  }
  const seen = new WeakSet();
  let visits = 0;
  function walk(object, depth) {
    if (!object || typeof object !== 'object' || depth > 7 || visits++ > 1500 || seen.has(object)) return;
    seen.add(object);
    for (const key of Object.keys(object)) {
      let value;
      try { value = object[key]; } catch { continue; }
      if (key === 'callback' && typeof value === 'function') callbacks.add(value);
      else if (value && typeof value === 'object' && !(value instanceof Element)) walk(value, depth + 1);
    }
  }
  const clients = Object.entries(window.___grecaptcha_cfg?.clients || {}).sort(([a], [b]) => Number(b) - Number(a));
  for (const [, client] of clients) {
    // Restrict callbacks to the matching widget when its sitekey is exposed.
    const keys = [];
    const visited = new WeakSet();
    const collectKeys = (object, depth = 0) => {
      if (!object || typeof object !== 'object' || depth > 7 || visited.has(object) || object instanceof Element) return;
      visited.add(object);
      for (const key of Object.keys(object)) {
        let value;
        try { value = object[key]; } catch { continue; }
        if (key === 'sitekey' && typeof value === 'string') keys.push(value);
        else if (value && typeof value === 'object') collectKeys(value, depth + 1);
      }
    };
    collectKeys(client);
    if (siteKey && keys.length && !keys.includes(siteKey)) continue;
    walk(client, 0);
    if (callbacks.size) break;
  }
  // Calling every widget callback can submit signup multiple times.
  const callback = callbacks.values().next().value;
  if (callback) callback(token);
  return { fields: fields.length, callbacks: callback ? 1 : 0 };
}

export class ApifyBrowser {
  constructor(page, selectors, solver) { this.page = page; this.s = selectors; this.solver = solver; this.solved = new Set(); }
  async visible(selector) { return this.page.locator(selector).first().isVisible().catch(() => false); }
  async solveIfPresent() {
    for (const frame of this.page.frames()) {
      let challenge;
      try { challenge = await frame.evaluate(detectRecaptcha); } catch { continue; }
      if (!challenge || this.solved.has(challenge.id)) continue;
      // Use the enclosing page URL for cross-origin widgets.
      challenge.websiteURL = this.page.url();
      const token = await this.solver.solve(challenge);
      let applied;
      try { applied = await frame.evaluate(applyRecaptchaToken, { token, siteKey: challenge.siteKey }); }
      catch {
        // Some callbacks navigate immediately, destroying the evaluation context.
        if (await this.verificationState() || await this.loginState()) {
          this.solved.add(challenge.id);
          return true;
        }
        throw new AppError('CAPTCHA_APPLY', 'Не удалось применить ответ reCAPTCHA к текущей форме.');
      }
      if (!applied.fields && !applied.callbacks) throw new AppError('CAPTCHA_CALLBACK', 'Не найдено поле или callback reCAPTCHA.');
      this.lastCaptchaApplied = applied;
      this.solved.add(challenge.id);
      return true;
    }
    return false;
  }
  async loginState() {
    const url = new URL(this.page.url());
    if (url.origin !== 'https://console.apify.com') return false;
    if (/sign-in|sign-up|verify|confirm/.test(url.pathname)) return false;
    // Avoid treating a redirect or loader as an authenticated session.
    return await this.page.getByRole('link', { name: /Actors|Settings|Dashboard/i }).first().isVisible().catch(() => false);
  }
  async verificationState() {
    return await this.page.getByText(new RegExp(this.s.verificationText, 'i')).first().isVisible().catch(() => false);
  }
  async auth(email, password, { resume = false, displayName = 'Automation User' } = {}) {
    this.solved.clear();
    await this.page.goto(`https://console.apify.com/${resume ? 'sign-in' : 'sign-up'}`, { waitUntil: 'domcontentloaded' });
    const bootstrapDeadline = Date.now() + 20000;
    while (Date.now() < bootstrapDeadline) {
      if (await this.visible(this.s.name) || await this.loginState() || await this.verificationState()) break;
      if (await this.visible(this.s.email)) {
        await this.page.locator(this.s.email).first().fill(email);
        break;
      }
      await delay(200);
    }
    let passwordFilled = false;
    let nextClicked = false;
    let submitted = false;
    let submitTime = 0;
    let nameFilled = false;
    let nameSubmitted = false;
    let captchaApplied = false;
    const deadline = Date.now() + 120000 + this.solver.config.timeoutMs * this.solver.config.maxTasks;
    while (Date.now() < deadline) {
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      if (!resume && /email is already taken|already.*(?:exist|registered)/i.test(bodyText)) {
        throw new AppError('ACCOUNT_EXISTS', 'Этот адрес уже зарегистрирован; нужно продолжить вход.');
      }
      if (/incorrect.*password|invalid.*credential|wrong.*password/i.test(bodyText)) {
        throw new AppError('AUTH_REJECTED', 'Apify отклонил сохранённые данные входа.');
      }
      if (await this.visible(this.s.name) && !nameFilled) {
        await this.page.locator(this.s.name).first().fill(displayName);
        nameFilled = true;
      }
      if (nameFilled && !nameSubmitted) {
        const advance = this.page.getByRole('button', { name: /^(?:continue|next|save|finish|complete|let.?s go|start)$/i }).first();
        if (await advance.isVisible().catch(() => false) && await advance.isEnabled()) {
          // The external CAPTCHA callback can leave Google's challenge overlay
          // visible after Apify has already accepted registration.
          await this.page.keyboard.press('Escape');
          await advance.press('Enter'); nameSubmitted = true;
          await delay(500);
          continue;
        }
      }
      if (await this.verificationState()) return 'verification';
      if (await this.loginState()) return 'authenticated';
      if (await this.visible(this.s.password) && !passwordFilled) {
        for (const field of await this.page.locator(this.s.password).all()) {
          if (await field.isVisible()) await field.fill(password);
        }
        passwordFilled = true;
      }
      const button = this.page.locator(resume ? this.s.login : this.s.signup).first();
      if (passwordFilled && !submitted && await button.isVisible() && await button.isEnabled()) {
        await button.click(); submitted = true; submitTime = Date.now();
      } else if (!nextClicked && !passwordFilled && await this.visible(this.s.next)) {
        await this.page.locator(this.s.next).first().click(); nextClicked = true;
      }
      // A mounted invisible widget is not a pending challenge. Solve only after
      // the completed signup/login form has actually been submitted.
      if (submitted && !captchaApplied) {
        const applied = await this.solveIfPresent();
        if (applied) captchaApplied = true;
        // A callback usually submits automatically; retry once if the form remains.
        if (applied && submitted) {
          await delay(1000);
          if (await this.verificationState()) return 'verification';
          if (await this.loginState()) return 'authenticated';
          if (this.lastCaptchaApplied?.callbacks === 0 && await button.isVisible() && await button.isEnabled()) {
            await button.click(); submitTime = Date.now();
          }
        }
      }
      const alert = this.page.getByRole('alert').first();
      if (submitted && Date.now() - submitTime > 2000 && await alert.isVisible().catch(() => false)) {
        const text = await alert.innerText();
        if (/already.*(?:exist|registered)|email.*(?:invalid|not allowed)|incorrect.*password|invalid.*credential/i.test(text)) {
          throw new AppError('AUTH_REJECTED', 'Apify отклонил регистрацию или вход. Данные сохранены для проверки.');
        }
      }
      await delay(500);
    }
    throw new AppError('AUTH_UI_TIMEOUT', 'Форма Apify не завершила вход. Возможно, изменился интерфейс или появился неподдерживаемый шаг.');
  }
  async verify(link) {
    const url = new URL(link);
    if (!['console.apify.com', 'api.apify.com'].includes(url.hostname) || url.protocol !== 'https:') {
      throw new AppError('MAIL_LINK', 'Недопустимый адрес подтверждения.');
    }
    await this.page.goto(link, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await this.loginState()) return true;
      await delay(500);
    }
    return false;
  }
  async createToken(description, onCreating, onCaptured) {
    await this.page.goto(this.s.integrationsUrl, { waitUntil: 'domcontentloaded' });
    await this.page.locator(this.s.newToken).first().click();
    const dialog = this.page.locator(this.s.tokenDialog).last();
    const descriptionField = dialog.locator(this.s.tokenDescription);
    if (await descriptionField.count()) await descriptionField.first().fill(description);
    else await dialog.getByRole('textbox').first().fill(description);
    await onCreating();
    await dialog.locator(this.s.createToken).click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const tokens = await this.page.evaluate(() => {
        const text = document.body.innerText + '\n' + [...document.querySelectorAll('input,textarea')].map(el => el.value).join('\n');
        return [...new Set(text.match(/apify_api_[A-Za-z0-9_-]{20,}/g) || [])];
      });
      if (tokens.length === 1) {
        // Persist before doing a validation request or any further UI action.
        await onCaptured(tokens[0]);
        return tokens[0];
      }
      if (tokens.length > 1) throw new AppError('TOKEN_AMBIGUOUS', 'На странице несколько токенов; автоматический выбор остановлен.');
      await delay(300);
    }
    throw new AppError('TOKEN_CAPTURE', 'Создание токена не удалось подтвердить. Повторный выпуск автоматически не выполняется.');
  }
}

export async function validateToken(token, email, fetcher = fetch) {
  const result = await jsonRequest('https://api.apify.com/v2/users/me', { headers: { Authorization: `Bearer ${token}` } }, fetcher);
  const user = result.data;
  if (!user?.id || typeof user.email !== 'string' || user.email.toLowerCase() !== email.toLowerCase()) {
    throw new AppError('TOKEN_IDENTITY', 'Не удалось подтвердить принадлежность токена нужному аккаунту.');
  }
  return user.id;
}
