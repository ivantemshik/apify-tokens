import { AppError } from './errors.js';

export function makeRunPlan(accounts, records, target) {
  if (!Number.isSafeInteger(target) || target < 1) throw new AppError('RUN_TARGET', 'Цель должна быть положительным целым числом.');
  const ready = accounts.filter(account => records[account.email]?.stage === 'done' && records[account.email]?.token);
  return {
    target, ready: ready.length,
    remaining: Math.max(0, target - ready.length),
    candidates: accounts.filter(account => !ready.includes(account)),
  };
}
