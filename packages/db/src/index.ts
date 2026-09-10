/**
 * @infra/db — Drizzle schema, client and typed queries for the Master DB (Neon PostgreSQL).
 */
export const PACKAGE_NAME = '@infra/db' as const;

export * from './schema/index.js';
export * from './client.js';
export * from './queries/index.js';
