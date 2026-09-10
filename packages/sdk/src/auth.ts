import { request } from './http.js';
import type { InfraAuthClient, InfraClientOptions, Result, Session, SocialProvider } from './types.js';

export function createAuthClient(options: InfraClientOptions): InfraAuthClient {
  return {
    signIn: {
      async email(input: { email: string; password: string }): Promise<Result<Session>> {
        return request<Session>(options, {
          method: 'POST',
          path: '/api/auth/sign-in/email',
          body: input,
          useApiKey: false,
        });
      },

      async social(provider: SocialProvider, opts: { callbackUrl?: string } = {}): Promise<Result<{ url: string }>> {
        return request<{ url: string }>(options, {
          method: 'POST',
          path: '/api/auth/sign-in/social',
          body: { provider, callbackURL: opts.callbackUrl ?? '/' },
          useApiKey: false,
        });
      },
    },

    signUp: {
      async email(input: { email: string; password: string; name: string }): Promise<Result<Session>> {
        return request<Session>(options, {
          method: 'POST',
          path: '/api/auth/sign-up/email',
          body: input,
          useApiKey: false,
        });
      },
    },

    async signOut(): Promise<Result<null>> {
      return request<null>(options, { method: 'POST', path: '/api/auth/sign-out', useApiKey: false });
    },

    async getSession(): Promise<Result<Session | null>> {
      return request<Session | null>(options, { method: 'GET', path: '/api/v1/me', useApiKey: true });
    },
  };
}
