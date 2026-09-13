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
    if (!/^(pk|sk)_(live|test)_[0-9A-Za-z]{32}$/.test(options.apiKey)) {
      throw new Error('[@infra/sdk] apiKey must look like sk_live_… (server) or pk_live_… (browser)');
    }
    // A publishable key is meant for the browser. A secret key never is.
    if (options.apiKey.startsWith('sk_') && isBrowser() && options.allowBrowserApiKey !== true) {
      throw new Error(
        '[@infra/sdk] refusing to use a secret key (sk_…) in a browser — it would be readable by ' +
          'anyone who opens devtools. Use a publishable key (pk_…) here and keep sk_ on your server.',
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
