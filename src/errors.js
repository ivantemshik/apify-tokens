export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function jsonRequest(url, options = {}, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch {
    throw new AppError('NETWORK_ERROR', 'Не удалось выполнить запрос к настроенному сервису.');
  }
  if (!response.ok) {
    const error = new AppError(`HTTP_${response.status}`, `Сервис вернул HTTP ${response.status}.`);
    // Preserve a bounded machine code, never raw error text or response bodies.
    const data = await response.json().catch(() => null);
    if (data?.errorId && typeof data.errorCode === 'string' && /^[A-Z_\d]{1,80}$/.test(data.errorCode)) {
      error.serviceCode = data.errorCode;
    }
    throw error;
  }
  try { return await response.json(); }
  catch { throw new AppError('INVALID_JSON', 'Сервис вернул ответ не в формате JSON.'); }
}
