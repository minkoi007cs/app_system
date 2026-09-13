/**
 * Better Auth core tables (user / session / account / verification) plus the
 * app-membership table that scopes a global identity to individual child apps.
 */
import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { infraApps } from './apps.js';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** App the session is currently acting in — set by the app-scope plugin. */
    activeAppId: uuid('active_app_id').references(() => infraApps.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** When this session last cleared an MFA challenge. Admin routes re-challenge after 8 hours. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Only set for email+password accounts; already a hash, never a plaintext password. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const APP_MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type AppMemberRole = (typeof APP_MEMBER_ROLES)[number];

/** user ↔ app relation: this is what makes a global identity app-scoped. */
export const infraAppMembers = pgTable(
  'infra_app_members',
  {
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('member').$type<AppMemberRole>(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.userId] }), index('infra_app_members_user_idx').on(t.userId)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(infraAppMembers),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const infraAppMemberRelations = relations(infraAppMembers, ({ one }) => ({
  app: one(infraApps, { fields: [infraAppMembers.appId], references: [infraApps.id] }),
  user: one(user, { fields: [infraAppMembers.userId], references: [user.id] }),
}));

export type UserRow = typeof user.$inferSelect;
export type SessionRow = typeof session.$inferSelect;
export type AppMemberRow = typeof infraAppMembers.$inferSelect;
