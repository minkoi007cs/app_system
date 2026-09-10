/** Drizzle relation graph — kept in one file so table modules stay acyclic. */
import { relations } from 'drizzle-orm';
import { infraApps } from './apps.js';
import { infraApiKeys } from './api-keys.js';
import { infraDatabaseConfigs } from './database-configs.js';
import { infraAuditLogs } from './audit-logs.js';
import { infraAppMembers, user } from './auth.js';

export const infraAppsRelations = relations(infraApps, ({ many }) => ({
  apiKeys: many(infraApiKeys),
  databaseConfigs: many(infraDatabaseConfigs),
  auditLogs: many(infraAuditLogs),
  members: many(infraAppMembers),
  owner: many(user),
}));

export const infraDatabaseConfigsRelations = relations(infraDatabaseConfigs, ({ one }) => ({
  app: one(infraApps, { fields: [infraDatabaseConfigs.appId], references: [infraApps.id] }),
}));

export const infraAuditLogsRelations = relations(infraAuditLogs, ({ one }) => ({
  app: one(infraApps, { fields: [infraAuditLogs.appId], references: [infraApps.id] }),
}));
