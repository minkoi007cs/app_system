/**
 * @infra/core — framework-agnostic primitives shared by every Unified-App-Infra package.
 * Must never import another @infra/* package.
 */
export const PACKAGE_NAME = '@infra/core' as const;

export * from './errors.js';
export * from './crypto.js';
export * from './api-key.js';
export * from './env.js';
