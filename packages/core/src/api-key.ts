/**
 * API keys handed to child applications.
 *
 * Format:   pk_live_<32 base62 chars>   (pk_test_ for non-production)
 * Storage:  sha256(raw) hex in infra_api_keys.key_hash — the raw key is shown once and never stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import { InfraError } from './errors.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62_REJECTION_CEILING = 248; // 4 * 62 — keeps the modulo unbiased

export const API_KEY_SECRET_LENGTH = 32;
export const API_KEY_DISPLAY_CHARS = 8;

export type ApiKeyEnvironment = 'live' | 'test';

export const API_KEY_PREFIXES: Readonly<Record<ApiKeyEnvironment, string>> = {
  live: 'pk_live_',
  test: 'pk_test_',
};

export type ApiKeyScope = 'db:read' | 'db:write' | 'auth:read' | 'admin';

export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['db:read', 'db:write', 'auth:read', 'admin'];

export interface GeneratedApiKey {
  /** Full secret. Show once to the user, then discard — it is never recoverable. */
  raw: string;
  /** sha256 hex — this is what goes into infra_api_keys.key_hash. */
  hash: string;
  /** Display-safe prefix, e.g. 'pk_live_a1B2c3D4'. */
  prefix: string;
  environment: ApiKeyEnvironment;
}

function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte >= BASE62_REJECTION_CEILING) continue;
      out += BASE62.charAt(byte % 62);
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateApiKey(environment: ApiKeyEnvironment = 'live'): GeneratedApiKey {
  const raw = `${API_KEY_PREFIXES[environment]}${randomBase62(API_KEY_SECRET_LENGTH)}`;
  return {
    raw,
    hash: hashApiKey(raw),
    prefix: apiKeyPrefix(raw),
    environment,
  };
}

/** Deterministic SHA-256 hex digest — the only representation ever persisted. */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

export function apiKeyEnvironmentOf(raw: string): ApiKeyEnvironment | null {
  const value = raw.trim();
  if (value.startsWith(API_KEY_PREFIXES.live)) return 'live';
  if (value.startsWith(API_KEY_PREFIXES.test)) return 'test';
  return null;
}

export function isApiKeyFormatValid(raw: string): boolean {
  const value = raw.trim();
  const environment = apiKeyEnvironmentOf(value);
  if (environment === null) return false;
  const secret = value.slice(API_KEY_PREFIXES[environment].length);
  if (secret.length !== API_KEY_SECRET_LENGTH) return false;
  for (const char of secret) {
    if (!BASE62.includes(char)) return false;
  }
  return true;
}

export interface ParsedApiKey {
  environment: ApiKeyEnvironment;
  secret: string;
  hash: string;
  prefix: string;
}

export function parseApiKey(raw: string): ParsedApiKey {
  const value = raw.trim();
  const environment = apiKeyEnvironmentOf(value);
  if (environment === null || !isApiKeyFormatValid(value)) {
    throw new InfraError('API_KEY_MALFORMED', 'API key is not a well-formed pk_live_ / pk_test_ key');
  }
  return {
    environment,
    secret: value.slice(API_KEY_PREFIXES[environment].length),
    hash: hashApiKey(value),
    prefix: apiKeyPrefix(value),
  };
}

/** 'pk_live_a1B2c3D4' — safe to store and display alongside the hash. */
export function apiKeyPrefix(raw: string): string {
  const value = raw.trim();
  const environment = apiKeyEnvironmentOf(value);
  if (environment === null) {
    throw new InfraError('API_KEY_MALFORMED', 'API key is missing its pk_live_ / pk_test_ prefix');
  }
  const marker = API_KEY_PREFIXES[environment];
  return `${marker}${value.slice(marker.length, marker.length + API_KEY_DISPLAY_CHARS)}`;
}

/** 'pk_live_a1B2c3D4••••••••••••••••••••••••' — for UI and logs. */
export function maskApiKey(raw: string): string {
  const prefix = apiKeyPrefix(raw);
  const hidden = Math.max(raw.trim().length - prefix.length, 0);
  return `${prefix}${'•'.repeat(hidden)}`;
}

export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes('admin') || granted.includes(required);
}

/** Extracts the raw key from an `Authorization: Bearer …` header. */
export function apiKeyFromAuthorizationHeader(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
