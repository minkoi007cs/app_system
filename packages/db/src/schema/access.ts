/**
 * RBAC + ABAC storage.
 *
 * Roles carry permission strings (`notes:read`, `-notes:delete`); assignments bind a subject to a
 * role within a scope. Policies carry the row-level conditions the gateway appends to queries.
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { PolicyAction, PolicyCondition, PolicyEffect } from '@infra/core';
import { infraApps } from './apps.js';

export const infraRoles = pgTable(
  'infra_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for a platform-wide role; set for a role that belongs to one app. */
    appId: uuid('app_id').references(() => infraApps.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 48 }).notNull(),
    name: varchar('name', { length: 96 }).notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('infra_roles_app_key_idx').on(t.appId, t.key)],
);

export type SubjectType = 'user' | 'service_account';
export type ScopeType = 'platform' | 'app' | 'workspace';

export const infraRoleAssignments = pgTable(
  'infra_role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: varchar('subject_type', { length: 16 }).notNull().$type<SubjectType>(),
    subjectId: text('subject_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => infraRoles.id, { onDelete: 'cascade' }),
    scopeType: varchar('scope_type', { length: 16 }).notNull().$type<ScopeType>(),
    scopeId: text('scope_id'),
    /** Temporary access expires on its own — the safest kind of grant. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_ra_subject_idx').on(t.subjectType, t.subjectId),
    index('infra_ra_scope_idx').on(t.scopeType, t.scopeId),
  ],
);

export const infraPolicies = pgTable(
  'infra_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    /** Table name in the tenant database, or '*' for every table. */
    resource: varchar('resource', { length: 64 }).notNull(),
    action: varchar('action', { length: 16 }).notNull().$type<PolicyAction>(),
    effect: varchar('effect', { length: 8 }).notNull().$type<PolicyEffect>(),
    condition: jsonb('condition').$type<PolicyCondition>().notNull(),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_policies_app_resource_idx').on(t.appId, t.resource, t.action)],
);

export type InfraRoleRow = typeof infraRoles.$inferSelect;
export type InfraRoleAssignmentRow = typeof infraRoleAssignments.$inferSelect;
export type InfraPolicyRow = typeof infraPolicies.$inferSelect;
