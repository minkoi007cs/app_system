/**
 * Turso provisioning — one LibSQL database per child app, plus its own auth token.
 *
 * Turso splits this into two calls: create the database, then mint a token for it. The token call
 * is the one that can fail after something exists, so a failure there deletes the database before
 * rethrowing. The token is scoped to that single database — a platform-wide token handed to one
 * app's config would be a key to every other app's data.
 */
import { InfraError } from '@infra/core';
import type { DbProvider } from '../types.js';
import { providerFetch } from './http.js';
import {
  FREE_TIER_LIMITS,
  type DatabaseProvisioner,
  type ProvisionRequest,
  type ProvisionedDatabase,
  type ProviderUsage,
} from './types.js';

export const TURSO_API_BASE = 'https://api.turso.tech/v1';

interface TursoDatabaseResponse {
  database?: { Name?: string; Hostname?: string; name?: string; hostname?: string };
}

interface TursoTokenResponse {
  jwt?: string;
}

interface TursoListResponse {
  databases?: Array<{ Name?: string; name?: string }>;
}

export interface TursoProvisionerOptions {
  apiToken?: string | undefined;
  organization?: string | undefined;
  group?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class TursoProvisioner implements DatabaseProvisioner {
  readonly provider: DbProvider = 'turso';

  private readonly apiToken: string;
  private readonly organization: string;
  private readonly group: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: TursoProvisionerOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.TURSO_API_TOKEN ?? '';
    this.organization = options.organization ?? process.env.TURSO_ORGANIZATION ?? '';
    this.group = options.group ?? process.env.TURSO_GROUP ?? 'default';
    this.apiBase = options.apiBase ?? TURSO_API_BASE;
    this.fetchImpl = options.fetchImpl;
  }

  isConfigured(): boolean {
    return this.apiToken !== '' && this.organization !== '';
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new InfraError(
        'CONFIG_INVALID',
        'TURSO_API_TOKEN and TURSO_ORGANIZATION must both be set — turso provisioning is disabled',
      );
    }
  }

  private get base(): string {
    return `${this.apiBase}/organizations/${encodeURIComponent(this.organization)}/databases`;
  }

  /** Turso names allow letters, digits and hyphens only, and must be unique in the org. */
  private nameFor(slug: string): string {
    return `uai-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedDatabase> {
    this.assertConfigured();

    const name = this.nameFor(request.slug);
    const created = await providerFetch<TursoDatabaseResponse>({
      method: 'POST',
      url: this.base,
      token: this.apiToken,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      body: { name, group: this.group },
    });

    const hostname = created.database?.Hostname ?? created.database?.hostname;
    if (hostname === undefined || hostname === '') {
      throw new InfraError('DB_CONNECTION_FAILED', 'turso did not return a hostname');
    }

    let token: string;
    try {
      const minted = await providerFetch<TursoTokenResponse>({
        method: 'POST',
        url: `${this.base}/${encodeURIComponent(name)}/auth/tokens`,
        token: this.apiToken,
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });

      if (minted.jwt === undefined || minted.jwt === '') {
        throw new InfraError('DB_CONNECTION_FAILED', 'turso did not return a database token');
      }
      token = minted.jwt;
    } catch (error) {
      // The database exists but is unusable — remove it rather than leave it counting against quota.
      await this.deprovision(name).catch(() => {});
      throw error;
    }

    return {
      provider: 'turso',
      externalId: name,
      connectionString: `libsql://${hostname}?authToken=${token}`,
      hostHint: hostname,
      region: null,
    };
  }

  async deprovision(externalId: string): Promise<void> {
    this.assertConfigured();

    try {
      await providerFetch<unknown>({
        method: 'DELETE',
        url: `${this.base}/${encodeURIComponent(externalId)}`,
        token: this.apiToken,
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
    } catch (error) {
      if (InfraError.is(error) && error.details['status'] === 404) return;
      throw error;
    }
  }

  async usage(): Promise<ProviderUsage> {
    this.assertConfigured();

    const list = await providerFetch<TursoListResponse>({
      method: 'GET',
      url: this.base,
      token: this.apiToken,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });

    return {
      provider: 'turso',
      used: list.databases?.length ?? 0,
      limit: FREE_TIER_LIMITS.turso,
      checkedAt: new Date(),
    };
  }
}
