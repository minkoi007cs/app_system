/**
 * @infra/sdk — turnkey client for child applications.
 * Zero runtime dependencies; only needs `fetch`.
 */
export const PACKAGE_NAME = '@infra/sdk' as const;

export { createInfraClient } from './client.js';
export { DEFAULT_TIMEOUT_MS, normaliseBaseUrl } from './http.js';
export type * from './types.js';
