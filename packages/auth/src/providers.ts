/**
 * OAuth providers are configured ONCE for the whole platform: every child app shares
 * the same callback URL, so Khoi never has to register an OAuth app per project.
 */
import type { ServerEnv } from '@infra/core';

export type OAuthProvider = 'google' | 'github' | 'microsoft';

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export type SocialProviderMap = Partial<Record<OAuthProvider, ProviderCredentials>>;

/** Only providers with BOTH id and secret are enabled — a half-configured provider is skipped. */
export function buildSocialProviders(env: ServerEnv): SocialProviderMap {
  const providers: SocialProviderMap = {};

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET };
  }

  return providers;
}

export function callbackUrlFor(publicUrl: string, provider: OAuthProvider): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/auth/callback/${provider}`;
}

/** Printed during setup so Khoi can paste the exact URLs into each OAuth console. */
export function allCallbackUrls(publicUrl: string): Record<OAuthProvider, string> {
  return {
    google: callbackUrlFor(publicUrl, 'google'),
    github: callbackUrlFor(publicUrl, 'github'),
    microsoft: callbackUrlFor(publicUrl, 'microsoft'),
  };
}
