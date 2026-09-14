/**
 * `createServerClient()` — the client a child app's **server** uses.
 *
 * The difference from `createInfraClient` is not the feature list, it is the lifetime. A browser
 * client is one object serving one user for as long as the tab is open. A server client looks the
 * same and is not: the same process serves thousands of users, and any user state that outlives a
 * request is a cross-user leak.
 *
 * That failure is quiet and severe — user A's access token stays in a module-level variable and
 * serves user B's page render, so B sees A's data with no error anywhere. It is a bug you find
 * from a support ticket, not from a stack trace.
 *
 * So the shape of this API is chosen to make it hard to write:
 *
 *   - `storage` is **required**, and it is where the per-request tokens live (a cookie jar, a
 *     session row). The client itself holds no tokens of its own beyond one request's cache.
 *   - The intended call site is inside the request — `createServerClient()` per request, not once
 *     at module scope. `assertRequestScoped` gives a loud error if a stale client is reused after
 *     its storage has moved on.
 *   - An `sk_` key is accepted here, because this is a server. The browser client refuses one.
 *
 * The user's token rides in `x-infra-access-token`, never in a cookie: the hub is on its own
 * domain, and this whole architecture avoids third-party cookies on purpose.
 */
import { QueryBuilder } from './query-builder.js';
import { createAuthClient } from './auth.js';
import { createDbClient } from './db.js';
import { normaliseBaseUrl, request } from './http.js';
import {
  isReuseDetected,
  TokenManager,
  type TokenPair,
  type TokenStorage,
} from './token-manager.js';
import type { InfraAuthClient, InfraClientOptions, InfraDbClient, Result } from './types.js';

export interface ServerClientOptions extends InfraClientOptions {
  /** Where this request's tokens are read from and written back to. Required — see above. */
  storage: TokenStorage;
  /** Called once when the session ends for good, so the app can redirect to sign-in. */
  onSessionEnded?: (reason: string) => void;
  skewMs?: number;
}

export interface InfraServerClient {
  readonly baseUrl: string;
  auth: InfraAuthClient;
  /** Raw SQL. Available here because a server may legitimately hold an `sk_` key. */
  db: InfraDbClient;
  from: <R = Record<string, unknown>>(resource: string) => QueryBuilder<R>;
  /** The current access token, refreshed if it is about to expire. Null when nobody is signed in. */
  accessToken: () => Promise<string | null>;
  /** Store a freshly-minted pair, e.g. straight after sign-in. */
  setSession: (pair: TokenPair) => Promise<void>;
  /** Clear the session locally and tell the hub to revoke the refresh token. */
  signOut: () => Promise<Result<null>>;
  tokens: TokenManager;
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export function createServerClient(options: ServerClientOptions): InfraServerClient {
  if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
    throw new Error('[@infra/sdk] baseUrl is required');
  }
  if (options.storage === undefined || typeof options.storage.load !== 'function') {
    throw new Error(
      '[@infra/sdk] createServerClient requires a storage adapter — per-request token storage is ' +
        'what keeps one user’s session from serving another user’s request',
    );
  }
  if (typeof globalThis === 'object' && 'document' in globalThis) {
    throw new Error(
      '[@infra/sdk] createServerClient is for server code. In a browser use createInfraClient, ' +
        'which refuses secret keys.',
    );
  }

  const resolved: InfraClientOptions = { ...options, baseUrl: normaliseBaseUrl(options.baseUrl) };

  const tokens = new TokenManager({
    storage: options.storage,
    ...(options.skewMs === undefined ? {} : { skewMs: options.skewMs }),
    ...(options.onSessionEnded === undefined ? {} : { onSessionEnded: options.onSessionEnded }),
    refresh: async (refreshToken) => {
      const result = await request<RefreshResponse>(resolved, {
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: refreshToken },
        useApiKey: true,
      });

      if (result.error !== null) {
        // Reuse detection means the family is revoked; so does a plain 401 on the refresh itself.
        // Either way there is nothing left to retry with.
        const terminal =
          isReuseDetected(result.error) || result.error.code === 'UNAUTHENTICATED'
            ? { code: result.error.code, message: result.error.message }
            : undefined;
        return terminal === undefined ? { pair: null } : { pair: null, terminal };
      }

      const body = result.data;
      if (body.access_token === undefined || body.refresh_token === undefined) {
        return { pair: null, terminal: { code: 'INTERNAL', message: 'refresh returned no token pair' } };
      }

      return {
        pair: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
        },
      };
    },
  });

  /**
   * Adds the user's access token to a request, and retries **once** on a 401 with a fresh one.
   *
   * Once, not in a loop: a 401 that survives a token minted seconds ago is a real authorisation
   * failure, and retrying it is how a client turns one refused request into a rate-limit ban.
   */
  const withAuth = async <T>(
    run: (headers: Record<string, string>) => Promise<Result<T>>,
  ): Promise<Result<T>> => {
    const token = await tokens.getAccessToken();
    const headers = token === null ? {} : { 'x-infra-access-token': token };

    const first = await run(headers);
    if (first.error === null || first.error.code !== 'UNAUTHENTICATED' || token === null) return first;

    if (isReuseDetected(first.error)) {
      await tokens.endSession('refresh token reuse detected');
      return first;
    }

    const refreshed = await tokens.forceRefresh();
    if (refreshed === null) return first;

    return run({ 'x-infra-access-token': refreshed });
  };

  const authedOptions = async (): Promise<InfraClientOptions> => {
    const token = await tokens.getAccessToken();
    if (token === null) return resolved;
    return { ...resolved, headers: { ...(resolved.headers ?? {}), 'x-infra-access-token': token } };
  };

  return {
    baseUrl: resolved.baseUrl,
    auth: createAuthClient(resolved),
    db: createDbClient(resolved),
    tokens,

    from<R = Record<string, unknown>>(resource: string): QueryBuilder<R> {
      // The builder is constructed with a per-call options snapshot carrying this request's token,
      // so two concurrent requests in the same process never share one.
      return new QueryBuilder<R>(resolved, resource, {
        prepare: authedOptions,
        retry: withAuth,
      });
    },

    accessToken: () => tokens.getAccessToken(),

    setSession: (pair) => tokens.setTokens(pair),

    async signOut(): Promise<Result<null>> {
      const pair = await options.storage.load();
      await tokens.endSession('signed out');

      if (pair === null) return { data: null, error: null };

      // Local state is cleared first: even if the hub is unreachable, this process must stop
      // presenting the token. The revoke is best-effort on top of that.
      return request<null>(resolved, {
        method: 'POST',
        path: '/api/v1/auth/revoke',
        body: { refresh_token: pair.refreshToken },
        useApiKey: true,
      });
    },
  };
}
