/**
 * Neon provisioning — one project per child app.
 *
 * A project, not a branch: projects are the unit Neon isolates and bills, and the free tier counts
 * ten of them. Two apps sharing a project with separate branches would share a compute endpoint and
 * a quota, which is exactly the isolation this platform exists to provide.
 *
 * Neon returns the connection string in the create response and nowhere else afterwards, so it is
 * captured here and sealed by the caller immediately. If that capture fails, the project is deleted
 * rather than left behind holding one of ten free slots.
 */
import { InfraError } from '@infra/core';
import type { DbProvider } from '../types.js';
import { hostHintFrom, providerFetch } from './http.js';
import {
  FREE_TIER_LIMITS,
  type DatabaseProvisioner,
  type ProvisionRequest,
  type ProvisionedDatabase,
  type ProviderUsage,
} from './types.js';

export const NEON_API_BASE = 'https://console.neon.tech/api/v2';

interface NeonConnectionUri {
  connection_uri?: string;
}

interface NeonProjectResponse {
  project?: { id?: string; region_id?: string };
  connection_uris?: NeonConnectionUri[];
}

interface NeonProjectListResponse {
  projects?: Array<{ id?: string }>;
}

export interface NeonProvisionerOptions {
  apiKey?: string | undefined;
  region?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class NeonProvisioner implements DatabaseProvisioner {
  readonly provider: DbProvider = 'neon';

  private readonly apiKey: string;
  private readonly region: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: NeonProvisionerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.NEON_API_KEY ?? '';
    this.region = options.region ?? process.env.NEON_REGION ?? 'aws-us-east-2';
    this.apiBase = options.apiBase ?? NEON_API_BASE;
    this.fetchImpl = options.fetchImpl;
  }

  isConfigured(): boolean {
    return this.apiKey !== '';
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new InfraError('CONFIG_INVALID', 'NEON_API_KEY is not set — neon provisioning is disabled');
    }
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedDatabase> {
    this.assertConfigured();

    const created = await providerFetch<NeonProjectResponse>({
      method: 'POST',
      url: `${this.apiBase}/projects`,
      token: this.apiKey,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      body: {
        project: {
          name: `uai-${request.slug}`,
          region_id: request.region ?? this.region,
        },
      },
    });

    const projectId = created.project?.id;
    const connectionString = created.connection_uris?.[0]?.connection_uri;

    if (projectId === undefined || projectId === '') {
      throw new InfraError('DB_CONNECTION_FAILED', 'neon did not return a project id');
    }

    if (connectionString === undefined || connectionString === '') {
      // Undo before reporting: a project we cannot connect to is pure quota loss.
      await this.deprovision(projectId).catch(() => {});
      throw new InfraError('DB_CONNECTION_FAILED', 'neon did not return a connection string', {
        details: { projectId },
      });
    }

    return {
      provider: 'neon',
      externalId: projectId,
      connectionString,
      hostHint: hostHintFrom(connectionString),
      region: created.project?.region_id ?? request.region ?? this.region,
    };
  }

  async deprovision(externalId: string): Promise<void> {
    this.assertConfigured();

    try {
      await providerFetch<unknown>({
        method: 'DELETE',
        url: `${this.apiBase}/projects/${encodeURIComponent(externalId)}`,
        token: this.apiKey,
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
    } catch (error) {
      // Already gone is the desired end state, so a 404 is not a failure.
      if (InfraError.is(error) && error.details['status'] === 404) return;
      throw error;
    }
  }

  async usage(): Promise<ProviderUsage> {
    this.assertConfigured();

    const list = await providerFetch<NeonProjectListResponse>({
      method: 'GET',
      url: `${this.apiBase}/projects`,
      token: this.apiKey,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });

    return {
      provider: 'neon',
      used: list.projects?.length ?? 0,
      limit: FREE_TIER_LIMITS.neon,
      checkedAt: new Date(),
    };
  }
}
