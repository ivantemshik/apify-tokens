import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export async function chromiumRuntime() {
  // Keep downloaded browsers inside this project, including on restricted desktops.
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH || 'data/browsers');
  return (await import('playwright')).chromium;
}

export async function installBrowser() {
  await chromiumRuntime();
  const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', windowsHide: true, env: process.env });
    child.on('error', () => reject(new AppError('BROWSER_INSTALL', 'Не удалось запустить установку Chromium.')));
    child.on('exit', code => code === 0 ? done() : reject(new AppError('BROWSER_INSTALL', 'Установка Chromium завершилась ошибкой.')));
  });
}
