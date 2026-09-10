import type { InfraClientOptions, InfraErrorCode, InfraErrorPayload, Result } from './types.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail<T>(
  code: InfraErrorCode,
  message: string,
  requestId = 'unknown',
  httpStatus?: number,
): Result<T> {
  const error: InfraErrorPayload =
    httpStatus === undefined ? { code, message, requestId } : { code, message, requestId, httpStatus };
  return { data: null, error };
}

interface ErrorBody {
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
}

const KNOWN_CODES = new Set<string>([
  'CONFIG_INVALID',
  'API_KEY_MALFORMED',
  'API_KEY_INVALID',
  'API_KEY_REVOKED',
  'API_KEY_EXPIRED',
  'FORBIDDEN_SCOPE',
  'UNAUTHENTICATED',
  'APP_NOT_FOUND',
  'APP_SUSPENDED',
  'DB_CONFIG_MISSING',
  'DB_CONNECTION_FAILED',
  'DB_QUERY_FAILED',
  'DB_QUERY_TIMEOUT',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'NETWORK_ERROR',
  'INTERNAL',
]);

function toErrorCode(value: unknown, httpStatus: number): InfraErrorCode {
  if (typeof value === 'string' && KNOWN_CODES.has(value)) return value as InfraErrorCode;
  if (httpStatus === 401) return 'UNAUTHENTICATED';
  if (httpStatus === 403) return 'FORBIDDEN_SCOPE';
  if (httpStatus === 404) return 'APP_NOT_FOUND';
  if (httpStatus === 429) return 'RATE_LIMITED';
  return 'INTERNAL';
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Auth endpoints ride on cookies; data endpoints ride on the API key. */
  useApiKey: boolean;
}

export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Single exit point for every network call. Never throws for a business failure —
 * transport problems become NETWORK_ERROR results.
 */
export async function request<T>(options: InfraClientOptions, req: RequestOptions): Promise<Result<T>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return fail<T>('CONFIG_INVALID', 'no fetch implementation available in this runtime');
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(options.headers ?? {}),
  };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  if (req.useApiKey && options.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${options.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${normaliseBaseUrl(options.baseUrl)}${req.path}`, {
      method: req.method,
      headers,
      credentials: options.credentials ?? 'include',
      signal: controller.signal,
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });

    const requestId = response.headers.get('x-request-id') ?? 'unknown';
    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeJsonParse(text);

    if (!response.ok) {
      const body = (parsed ?? {}) as ErrorBody;
      const code = toErrorCode(body.error?.code ?? body.code, response.status);
      const message = body.error?.message ?? body.message ?? `request failed with status ${response.status}`;
      return fail<T>(code, message, requestId, response.status);
    }

    // Envelope-aware unwrap: { data } responses unwrap, bare bodies pass through.
    // `{ data: null }` must stay null rather than falling back to the envelope itself.
    const payload =
      parsed !== null && typeof parsed === 'object' && 'data' in parsed
        ? (parsed as { data: T }).data
        : (parsed as T);
    return ok(payload);
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return fail<T>(
      aborted ? 'DB_QUERY_TIMEOUT' : 'NETWORK_ERROR',
      aborted ? 'request timed out' : 'unable to reach the infra server',
    );
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
