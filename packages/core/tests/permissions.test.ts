import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  InfraError,
  mergePermissions,
  parsePermission,
  permissionMatches,
  SYSTEM_ROLES,
} from '../src/index.js';

describe('parsePermission', () => {
  it('splits resource and action', () => {
    expect(parsePermission('notes:read')).toEqual({ resource: 'notes', action: 'read' });
    expect(parsePermission('  NOTES:READ ')).toEqual({ resource: 'notes', action: 'read' });
  });

  it('rejects anything that is not resource:action', () => {
    for (const junk of ['notes', 'notes:', ':read', 'notes:read:extra', 'notes read', '']) {
      expect(() => parsePermission(junk)).toThrowError(InfraError);
    }
  });
});

describe('permissionMatches', () => {
  it('matches exactly', () => {
    expect(permissionMatches('notes:read', 'notes:read')).toBe(true);
    expect(permissionMatches('notes:read', 'notes:write')).toBe(false);
    expect(permissionMatches('notes:read', 'files:read')).toBe(false);
  });

  it('honours whole-segment wildcards', () => {
    expect(permissionMatches('notes:*', 'notes:delete')).toBe(true);
    expect(permissionMatches('*:read', 'anything:read')).toBe(true);
    expect(permissionMatches('*:*', 'anything:anything')).toBe(true);
  });

  it('does NOT treat a wildcard as a partial glob', () => {
    // "not*" must not match "notes" — a prefix wildcard would be a quiet privilege escalation.
    expect(permissionMatches('not*:read', 'notes:read')).toBe(false);
    expect(permissionMatches('notes:re*', 'notes:read')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('grants when any allow matches', () => {
    expect(hasPermission(['notes:read', 'files:*'], 'files:delete')).toBe(true);
  });

  it('refuses when nothing matches', () => {
    expect(hasPermission(['notes:read'], 'notes:write')).toBe(false);
    expect(hasPermission([], 'notes:read')).toBe(false);
  });

  it('lets an explicit deny beat even a total wildcard', () => {
    expect(hasPermission(['*:*', '-notes:delete'], 'notes:delete')).toBe(false);
    expect(hasPermission(['*:*', '-notes:delete'], 'notes:read')).toBe(true);
  });

  it('lets a broad deny beat a specific allow', () => {
    // The narrow allow must NOT punch a hole through the broad deny.
    expect(hasPermission(['notes:delete', '-*:delete'], 'notes:delete')).toBe(false);
  });
});

describe('mergePermissions', () => {
  it('unions roles and de-duplicates', () => {
    expect(mergePermissions([['notes:read'], ['notes:read', 'files:*']]).sort()).toEqual([
      'files:*',
      'notes:read',
    ]);
  });

  it('keeps denies from being lost when roles are combined', () => {
    const merged = mergePermissions([['*:*'], ['-notes:delete']]);
    expect(hasPermission(merged, 'notes:delete')).toBe(false);
    expect(hasPermission(merged, 'notes:read')).toBe(true);
  });
});

describe('SYSTEM_ROLES', () => {
  it('owner can do everything', () => {
    expect(hasPermission([...SYSTEM_ROLES['owner']!], 'anything:anything')).toBe(true);
  });

  it('member reads but does not write', () => {
    const member = [...SYSTEM_ROLES['member']!];
    expect(hasPermission(member, 'notes:read')).toBe(true);
    expect(hasPermission(member, 'notes:write')).toBe(false);
  });

  it('viewer reads but can never delete', () => {
    const viewer = [...SYSTEM_ROLES['viewer']!];
    expect(hasPermission(viewer, 'notes:read')).toBe(true);
    expect(hasPermission(viewer, 'notes:delete')).toBe(false);
  });
});
