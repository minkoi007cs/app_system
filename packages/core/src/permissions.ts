/**
 * Permission matching for RBAC.
 *
 * Permissions read `resource:action` — `notes:read`, `notes:*`, `*:read`, `*:*`.
 * Two rules decide everything:
 *   · a wildcard matches any single segment, never a partial one ("not*" does not match "notes")
 *   · an explicit deny beats every allow, however specific the allow is
 *
 * Deny-wins is the part people get wrong. If the most specific rule won instead, adding a narrow
 * allow somewhere would silently punch a hole through a broad deny.
 */
import { InfraError } from './errors.js';

export const PERMISSION_PATTERN = /^[a-z0-9_*]+:[a-z0-9_*]+$/;

export interface ParsedPermission {
  resource: string;
  action: string;
}

export function parsePermission(permission: string): ParsedPermission {
  const value = permission.trim().toLowerCase();
  if (!PERMISSION_PATTERN.test(value)) {
    throw new InfraError('VALIDATION_FAILED', `permission must look like resource:action — got "${permission}"`);
  }
  const [resource, action] = value.split(':');
  return { resource: resource ?? '', action: action ?? '' };
}

function segmentMatches(pattern: string, value: string): boolean {
  // Only a whole-segment wildcard is honoured; partial globs are not a feature.
  return pattern === '*' || pattern === value;
}

export function permissionMatches(granted: string, required: string): boolean {
  const a = parsePermission(granted);
  const b = parsePermission(required);
  return segmentMatches(a.resource, b.resource) && segmentMatches(a.action, b.action);
}

export function hasPermission(granted: readonly string[], required: string): boolean {
  // A deny is written as "-resource:action".
  const denies = granted.filter((entry) => entry.startsWith('-')).map((entry) => entry.slice(1));
  if (denies.some((deny) => permissionMatches(deny, required))) return false;

  return granted
    .filter((entry) => !entry.startsWith('-'))
    .some((allow) => permissionMatches(allow, required));
}

/** Flattens several roles into one set, keeping denies in front where they belong. */
export function mergePermissions(roles: ReadonlyArray<readonly string[]>): string[] {
  const merged = new Set<string>();
  for (const role of roles) for (const permission of role) merged.add(permission.trim().toLowerCase());
  return [...merged].sort((a, b) => Number(b.startsWith('-')) - Number(a.startsWith('-')));
}

/** Built-in roles every new app starts with. */
export const SYSTEM_ROLES: Readonly<Record<string, readonly string[]>> = {
  owner: ['*:*'],
  admin: ['*:read', '*:write', '*:create', '*:delete'],
  member: ['*:read'],
  viewer: ['*:read', '-*:delete'],
};
