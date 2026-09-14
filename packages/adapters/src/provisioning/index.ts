/**
 * Provisioner registry.
 *
 * Supabase has no free-tier project-creation API, so it is deliberately absent: a connection string
 * for a Supabase project is pasted in by hand. Claiming support and failing at runtime would be
 * worse than saying so here.
 */
import type { DbProvider } from '../types.js';
import { NeonProvisioner } from './neon.provisioner.js';
import { TursoProvisioner } from './turso.provisioner.js';
import type { DatabaseProvisioner, ProviderUsage } from './types.js';

export * from './types.js';
export * from './http.js';
export * from './neon.provisioner.js';
export * from './turso.provisioner.js';

export const PROVISIONABLE_PROVIDERS: readonly DbProvider[] = ['neon', 'turso'];

export function createProvisioner(provider: DbProvider): DatabaseProvisioner {
  switch (provider) {
    case 'neon':
      return new NeonProvisioner();
    case 'turso':
      return new TursoProvisioner();
    case 'supabase':
      throw new Error('supabase has no provisioning api on the free tier — attach a connection string');
  }
}

/** Which providers this deployment can actually provision on, given the credentials it holds. */
export function configuredProvisioners(): DatabaseProvisioner[] {
  return PROVISIONABLE_PROVIDERS.map(createProvisioner).filter((p) => p.isConfigured());
}

/** One usage reading per configured provider; a provider that errors reports as unknown, not zero. */
export async function collectUsage(): Promise<ProviderUsage[]> {
  return Promise.all(
    configuredProvisioners().map(async (provisioner) => {
      try {
        return await provisioner.usage();
      } catch {
        return { provider: provisioner.provider, used: -1, limit: null, checkedAt: new Date() };
      }
    }),
  );
}
