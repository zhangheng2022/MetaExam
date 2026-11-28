import type { ApiError } from '@metaexam/contracts';
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function apiResponse(
  url: string,
  method = 'GET',
  body?: unknown,
  timeout = 20000,
): Promise<Response> {
  let r: Response;
  try {
    r = await fetch('/api/v1' + url, {
      method,
      credentials: 'same-origin',
      headers:
        body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new RequestError(503, 'SERVICE_UNAVAILABLE', '服务连接失败，请检查后台服务后重试。');
  }
  if (!r.ok) {
    const error = (await r.json().catch(() => ({}))) as Partial<ApiError>;
    if (r.status === 401 && url !== '/auth/login' && error.code !== 'INVALID_CREDENTIALS')
      window.dispatchEvent(new Event('metaexam:session-expired'));
    const messages: Record<number, string> = {
      401: '登录已过期，请重新登录。',
      403: '没有访问权限。',
      429: '操作过于频繁，请稍后重试。',
      503: '数据库暂时不可用，请稍后重试。',
    };
    throw new RequestError(
      r.status,
      error.code ?? 'REQUEST_FAILED',
      error.message ?? messages[r.status] ?? '请求失败，请重试。',
    );
  }
  return r;
}
export async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await apiResponse(url, method, body);
  return r.status === 204 ? (undefined as T) : (r.json() as Promise<T>);
}
