/**
 * API keys handed to child applications.
 *
 * Two kinds, and the difference is not cosmetic:
 *
 *   sk_live_…  SECRET       — server only. Full power: raw SQL, admin endpoints, no user needed.
 *   pk_live_…  PUBLISHABLE  — safe to ship in a browser bundle. Can only start an auth flow and
 *                             read data through the rules engine, and only while carrying a
 *                             user's access token.
 *
 * The prefix follows the industry convention (Stripe, Supabase, Clerk) precisely because
 * developers read `pk_` as "safe to publish". A key whose name says publishable must never be
 * able to do what a secret key does.
 */
import { createHash, randomBytes } from 'node:crypto';
import { InfraError } from './errors.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62_REJECTION_CEILING = 248; // 4 * 62 — keeps the modulo unbiased

export const API_KEY_SECRET_LENGTH = 32;
export const API_KEY_DISPLAY_CHARS = 8;

export type ApiKeyEnvironment = 'live' | 'test';
export type ApiKeyKind = 'publishable' | 'secret';

export type ApiKeyScope = 'db:read' | 'db:write' | 'auth:read' | 'admin';
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['db:read', 'db:write', 'auth:read', 'admin'];

/** Scopes a publishable key may ever hold, whatever an admin ticks in the UI. */
export const PUBLISHABLE_ALLOWED_SCOPES: readonly ApiKeyScope[] = ['db:read', 'auth:read'];

export function apiKeyPrefixFor(kind: ApiKeyKind, environment: ApiKeyEnvironment): string {
  return `${kind === 'secret' ? 'sk' : 'pk'}_${environment}_`;
}

export interface GeneratedApiKey {
  /** Full secret. Show once, then discard — it is never recoverable. */
  raw: string;
  /** sha256 hex — the only representation ever persisted. */
  hash: string;
  /** Display-safe prefix, e.g. 'sk_live_a1B2c3D4'. */
  prefix: string;
  kind: ApiKeyKind;
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

export function generateApiKey(
  kind: ApiKeyKind = 'secret',
  environment: ApiKeyEnvironment = 'live',
): GeneratedApiKey {
  const raw = `${apiKeyPrefixFor(kind, environment)}${randomBase62(API_KEY_SECRET_LENGTH)}`;
  return { raw, hash: hashApiKey(raw), prefix: apiKeyPrefix(raw), kind, environment };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw.trim(), 'utf8').digest('hex');
}

export interface ApiKeyShape {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  marker: string;
}

export function apiKeyShapeOf(raw: string): ApiKeyShape | null {
  const value = raw.trim();
  for (const kind of ['secret', 'publishable'] as const) {
    for (const environment of ['live', 'test'] as const) {
      const marker = apiKeyPrefixFor(kind, environment);
      if (value.startsWith(marker)) return { kind, environment, marker };
    }
  }
  return null;
}

export function isApiKeyFormatValid(raw: string): boolean {
  const value = raw.trim();
  const shape = apiKeyShapeOf(value);
  if (shape === null) return false;
  const secret = value.slice(shape.marker.length);
  if (secret.length !== API_KEY_SECRET_LENGTH) return false;
  for (const char of secret) {
    if (!BASE62.includes(char)) return false;
  }
  return true;
}

export interface ParsedApiKey {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  secret: string;
  hash: string;
  prefix: string;
}

export function parseApiKey(raw: string): ParsedApiKey {
  const value = raw.trim();
  const shape = apiKeyShapeOf(value);
  if (shape === null || !isApiKeyFormatValid(value)) {
    throw new InfraError('API_KEY_MALFORMED', 'API key is not a well-formed pk_/sk_ key');
  }
  return {
    kind: shape.kind,
    environment: shape.environment,
    secret: value.slice(shape.marker.length),
    hash: hashApiKey(value),
    prefix: apiKeyPrefix(value),
  };
}

/** 'sk_live_a1B2c3D4' — safe to store and display next to the hash. */
export function apiKeyPrefix(raw: string): string {
  const value = raw.trim();
  const shape = apiKeyShapeOf(value);
  if (shape === null) {
    throw new InfraError('API_KEY_MALFORMED', 'API key is missing its pk_/sk_ prefix');
  }
  return `${shape.marker}${value.slice(shape.marker.length, shape.marker.length + API_KEY_DISPLAY_CHARS)}`;
}

export function maskApiKey(raw: string): string {
  const prefix = apiKeyPrefix(raw);
  const hidden = Math.max(raw.trim().length - prefix.length, 0);
  return `${prefix}${'•'.repeat(hidden)}`;
}

export function hasScope(granted: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes('admin') || granted.includes(required);
}

/** Publishable keys are capped regardless of what was requested. */
export function normaliseScopes(kind: ApiKeyKind, requested: readonly ApiKeyScope[]): ApiKeyScope[] {
  if (kind === 'secret') return [...requested];
  const allowed = requested.filter((scope) => PUBLISHABLE_ALLOWED_SCOPES.includes(scope));
  return allowed.length > 0 ? allowed : ['auth:read'];
}

export function apiKeyFromAuthorizationHeader(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * A secret key arriving from a browser means it has been shipped to the client.
 * Treat the request as hostile: the key is already compromised.
 */
export function looksLikeBrowserRequest(origin: string | null, referer: string | null): boolean {
  return (origin !== null && origin !== '') || (referer !== null && referer !== '');
}
