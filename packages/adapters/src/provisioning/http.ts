/**
 * The one place provider HTTP calls are made.
 *
 * Everything here exists because a provisioning call is an outbound request carrying a credential
 * that can create and destroy databases:
 *
 *   - a hard timeout, so a provider outage does not hold a request open;
 *   - errors that carry the status code and never the response body, because a provider echoing
 *     part of the request back into an error message is how an API token ends up in a log;
 *   - no retries on anything that creates — a retried create is how you get two projects and one
 *     record of them.
 */
import { InfraError } from '@infra/core';

export const PROVIDER_TIMEOUT_MS = 20_000;

export interface ProviderRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  token: string;
  body?: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function providerFetch<T>(request: ProviderRequest): Promise<T> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs ?? PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${request.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });

    if (response.status === 204) return undefined as T;

    if (!response.ok) {
      // Status only. The body is provider-controlled text and may quote what we sent it.
      throw new InfraError('DB_CONNECTION_FAILED', 'provider rejected the provisioning request', {
        details: { status: response.status, method: request.method },
      });
    }

    return (await response.json()) as T;
  } catch (cause) {
    if (InfraError.is(cause)) throw cause;
    const timedOut = cause instanceof Error && cause.name === 'AbortError';
    throw new InfraError(
      timedOut ? 'DB_QUERY_TIMEOUT' : 'DB_CONNECTION_FAILED',
      timedOut ? 'provider did not answer in time' : 'could not reach the provider',
      { cause, details: { method: request.method } },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Trims a connection string down to host:port for display. Returns null rather than guessing. */
export function hostHintFrom(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  } catch {
    return null;
  }
}
