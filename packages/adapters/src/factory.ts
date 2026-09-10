import { InfraError } from '@infra/core';
import { createPostgresAdapter } from './postgres.adapter.js';
import { createLibsqlAdapter } from './libsql.adapter.js';
import { DIALECT_BY_PROVIDER, type AdapterConfig, type DatabaseAdapter } from './types.js';

/** Single place that knows which driver serves which provider. */
export function createAdapter(config: AdapterConfig): DatabaseAdapter {
  const dialect = DIALECT_BY_PROVIDER[config.provider];
  switch (dialect) {
    case 'postgres':
      return createPostgresAdapter(config);
    case 'libsql':
      return createLibsqlAdapter(config);
    default:
      throw new InfraError('CONFIG_INVALID', `unsupported provider ${String(config.provider)}`);
  }
}
