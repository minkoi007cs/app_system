import type { QueryBuilder } from './query-builder.js';

/**
 * @infra/sdk public types.
 * This package is shipped to child apps: it must stay dependency-free and must never
 * import server code (no Drizzle, no Better Auth server, no node:crypto).
 */

export type InfraErrorCode =
  | 'CONFIG_INVALID'
  | 'API_KEY_MALFORMED'
  | 'API_KEY_INVALID'
  | 'API_KEY_REVOKED'
  | 'API_KEY_EXPIRED'
  | 'FORBIDDEN_SCOPE'
  | 'UNAUTHENTICATED'
  | 'APP_NOT_FOUND'
  | 'APP_SUSPENDED'
  | 'DB_CONFIG_MISSING'
  | 'DB_CONNECTION_FAILED'
  | 'DB_QUERY_FAILED'
  | 'DB_QUERY_TIMEOUT'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'NETWORK_ERROR'
  | 'INTERNAL';

export interface InfraErrorPayload {
  code: InfraErrorCode;
  message: string;
  requestId: string;
  httpStatus?: number;
}

/** Supabase-style result: business failures are values, not exceptions. */
export type Result<T> = { data: T; error: null } | { data: null; error: InfraErrorPayload };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
}

export interface Session {
  user: SessionUser;
  appId: string;
  expiresAt: string;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number | null;
  checkedAt: string;
  provider?: string;
}

export type SocialProvider = 'google' | 'github' | 'microsoft';

export interface InfraClientOptions {
  /** Where Unified-App-Infra is hosted, e.g. https://infra.example.com */
  baseUrl: string;
  /** pk_live_… — SERVER SIDE ONLY. Never ship this to a browser bundle. */
  apiKey?: string;
  /** Override for tests or non-standard runtimes. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Send cookies for browser-side auth calls. Defaults to 'include'. */
  credentials?: RequestCredentials;
  /** Escape hatch for trusted browser environments. Off by default on purpose. */
  allowBrowserApiKey?: boolean;
}

export interface InfraDbClient {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Result<R[]>>;
  queryOne<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Result<R | null>>;
  health(): Promise<Result<HealthReport>>;
}

export interface InfraAuthClient {
  signIn: {
    email(input: { email: string; password: string }): Promise<Result<Session>>;
    social(provider: SocialProvider, options?: { callbackUrl?: string }): Promise<Result<{ url: string }>>;
  };
  signUp: {
    email(input: { email: string; password: string; name: string }): Promise<Result<Session>>;
  };
  signOut(): Promise<Result<null>>;
  getSession(): Promise<Result<Session | null>>;
}

export interface InfraClient {
  readonly baseUrl: string;
  auth: InfraAuthClient;
  /** Raw SQL. Needs an `sk_` key and bypasses the rules engine — server side only. */
  db: InfraDbClient;
  /**
   * The rules-enforced query builder. Safe with a publishable key, because the server builds the
   * statement from this description and always ANDs the caller's policy condition into it.
   */
  from: <R = Record<string, unknown>>(resource: string) => QueryBuilder<R>;
}
