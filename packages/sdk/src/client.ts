import { createAuthClient } from './auth.js';
import { createDbClient } from './db.js';
import { normaliseBaseUrl } from './http.js';
import type { InfraClient, InfraClientOptions } from './types.js';

function isBrowser(): boolean {
  return typeof globalThis === 'object' && 'window' in globalThis && 'document' in globalThis;
}

/**
 * Entry point for child applications.
 *
 *   const infra = createInfraClient({ baseUrl, apiKey });
 *   const { data, error } = await infra.db.query('select 1');
 *
 * Throws only for a misconfigured client — every runtime failure is returned as
 * `{ data: null, error }` instead.
 */
export function createInfraClient(options: InfraClientOptions): InfraClient {
  if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
    throw new Error('[@infra/sdk] baseUrl is required');
  }

  if (options.apiKey !== undefined) {
    if (!/^pk_(live|test)_[0-9A-Za-z]{32}$/.test(options.apiKey)) {
      throw new Error('[@infra/sdk] apiKey must look like pk_live_… or pk_test_…');
    }
    if (isBrowser() && options.allowBrowserApiKey !== true) {
      throw new Error(
        '[@infra/sdk] refusing to use an API key in a browser. Keep pk_live_ keys on your server, ' +
          'or pass allowBrowserApiKey: true if you really know what you are doing.',
      );
    }
  }

  const resolved: InfraClientOptions = { ...options, baseUrl: normaliseBaseUrl(options.baseUrl) };

  return {
    baseUrl: resolved.baseUrl,
    auth: createAuthClient(resolved),
    db: createDbClient(resolved),
  };
}
