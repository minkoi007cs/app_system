/**
 * @infra/auth — Better Auth instance, OAuth providers and app scoping.
 */
export const PACKAGE_NAME = '@infra/auth' as const;

export * from './providers.js';
export * from './app-scope.plugin.js';
// Membership queries live in @infra/db (single drizzle instance); re-exported here for convenience.
export {
  addMember,
  removeMember,
  getMembership,
  requireMembership,
  listMembersOfApp,
  listAppsForUser,
  type Membership,
  type AppMemberSummary,
} from '@infra/db';
export * from './server.js';
export * from './tokens.js';
export * from './passkey.js';
export * from './access.js';
export * from './recovery.js';
export * from './gateway.js';
