/**
 * The centralized authentication hub.
 * One Better Auth instance serves every child app; isolation comes from app scoping
 * (infra_app_members + session.activeAppId), not from separate auth deployments.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { parseServerEnv, type ServerEnv } from '@infra/core';
import { loadAllTrustedOrigins, masterDb, schema, type MasterDatabase } from '@infra/db';
import { appScopePlugin } from './app-scope.plugin.js';
import { buildSocialProviders } from './providers.js';

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface CreateAuthOptions {
  env?: ServerEnv;
  db?: MasterDatabase;
}

export function createAuth(options: CreateAuthOptions = {}) {
  const env = options.env ?? parseServerEnv();
  const db = options.db ?? masterDb();

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, { provider: 'pg', schema }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: env.NODE_ENV === 'production',
      minPasswordLength: 12,
    },

    socialProviders: buildSocialProviders(env),

    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },

    advanced: {
      cookiePrefix: 'infra',
      useSecureCookies: env.NODE_ENV === 'production',
    },

    // Child apps register their own browser origins; the hub trusts exactly those.
    trustedOrigins: async () => [env.INFRA_PUBLIC_URL, ...(await loadAllTrustedOrigins(db))],

    plugins: [appScopePlugin()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

interface AuthGlobal {
  __infraAuth?: Auth;
}

const authGlobal = globalThis as unknown as AuthGlobal;

/** Process-wide singleton, HMR-safe in development. */
export function auth(): Auth {
  authGlobal.__infraAuth ??= createAuth();
  return authGlobal.__infraAuth;
}
