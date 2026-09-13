/**
 * Boot-time environment validation. A missing or malformed variable must crash the
 * process immediately rather than surface as a confusing runtime failure later.
 */
import { z } from 'zod';
import { InfraError } from './errors.js';

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes encoded as 64 hexadecimal characters');

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  INFRA_MASTER_DATABASE_URL: z.string().min(1, 'is required'),
  INFRA_MASTER_ENCRYPTION_KEY: hex64,

  BETTER_AUTH_SECRET: z.string().min(16, 'must be at least 16 characters'),
  BETTER_AUTH_URL: z.string().min(1, 'is required'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  /** Comma-separated emails allowed to hold platform admin rights. Not editable from the UI. */
  INFRA_SUPER_ADMIN_EMAILS: z.string().optional(),
  INFRA_PUBLIC_URL: z.string().min(1).default('http://localhost:3000'),
  INFRA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Parses and validates the environment. On failure the thrown error lists the offending
 * variable NAMES and the reason — never their values.
 */
export function parseServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key} ${issue.message}`;
  });

  throw new InfraError('CONFIG_INVALID', `invalid environment: ${problems.join('; ')}`, {
    details: { variables: result.error.issues.map((issue) => issue.path.join('.')) },
  });
}

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv();
  return cached;
}

/** Test helper — forces the next serverEnv() call to re-read process.env. */
export function resetServerEnvCache(): void {
  cached = null;
}

/** Parses the allowlist. An empty list means nobody can hold admin rights — deliberately. */
export function superAdminEmails(env: Pick<ServerEnv, 'INFRA_SUPER_ADMIN_EMAILS'>): string[] {
  return (env.INFRA_SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== '');
}

export function isSuperAdminEmail(email: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(email.trim().toLowerCase());
}

export type OAuthProvider = 'google' | 'github' | 'microsoft';

/** Which OAuth providers are actually configured in this deployment. */
export function configuredOAuthProviders(env: ServerEnv): OAuthProvider[] {
  const providers: OAuthProvider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) providers.push('google');
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) providers.push('github');
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) providers.push('microsoft');
  return providers;
}
