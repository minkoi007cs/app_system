/**
 * Parameter binding is the ONLY channel through which values reach a tenant database.
 * These converters validate what a child app sends before it touches a driver.
 */
import { InfraError } from '@infra/core';

function reject(index: number, received: string): never {
  throw new InfraError('VALIDATION_FAILED', `query parameter #${index + 1} has unsupported type ${received}`, {
    details: { index, received },
  });
}

/** postgres-js serialisable values. Note: no bigint — PostgreSQL bigint binds as a string. */
export type PostgresBoundValue = string | number | boolean | null | Date | Uint8Array;

export function toPostgresParams(params: readonly unknown[]): PostgresBoundValue[] {
  return params.map((value, index) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value instanceof Date ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    return reject(index, typeof value);
  });
}

/** LibSQL has a narrower set: no Date, no boolean — they are normalised here. */
export function toLibsqlParams(params: readonly unknown[]): Array<string | number | bigint | null | Uint8Array> {
  return params.map((value, index) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    return reject(index, typeof value);
  });
}
