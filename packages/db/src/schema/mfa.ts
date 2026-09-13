/**
 * Multi-factor authentication.
 *
 * A user may enrol several factors; `isPrimary` picks the one offered first. TOTP seeds are
 * encrypted with the same AES-256-GCM envelope as every other secret (AAD `mfa:<factor id>`),
 * and backup codes are stored only as SHA-256 hashes, burned individually as they are used.
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const MFA_FACTOR_TYPES = ['totp', 'webauthn', 'backup_code', 'email_otp'] as const;
export type MfaFactorType = (typeof MFA_FACTOR_TYPES)[number];

export const infraMfaFactors = pgTable(
  'infra_mfa_factors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 16 }).notNull().$type<MfaFactorType>(),
    label: varchar('label', { length: 64 }).notNull(),

    // TOTP seed, sealed. Null for factor types that do not have one.
    encryptedSecret: text('encrypted_secret'),
    encryptionIv: varchar('encryption_iv', { length: 24 }),
    encryptionAuthTag: varchar('encryption_auth_tag', { length: 32 }),
    encryptionKeyVersion: integer('encryption_key_version').default(1),

    /** SHA-256 of each unused backup code. Entries are removed as they are consumed. */
    backupCodeHashes: jsonb('backup_code_hashes').$type<string[]>().notNull().default([]),

    // WebAuthn columns, filled in by T5.9.
    credentialId: text('credential_id'),
    publicKey: text('public_key'),
    signCount: integer('sign_count').default(0),
    transports: jsonb('transports').$type<string[]>(),

    isPrimary: boolean('is_primary').notNull().default(false),
    /** Null until the user proves they can produce a code — an unverified factor never counts. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** The TOTP step last accepted, so the same code cannot be replayed inside its window. */
    lastUsedStep: integer('last_used_step'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_mfa_user_idx').on(t.userId), index('infra_mfa_credential_idx').on(t.credentialId)],
);

export const infraTrustedDevices = pgTable(
  'infra_trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceHash: varchar('device_hash', { length: 64 }).notNull(),
    label: varchar('label', { length: 96 }),
    trustedUntil: timestamp('trusted_until', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_trusted_devices_user_idx').on(t.userId)],
);

export type InfraMfaFactorRow = typeof infraMfaFactors.$inferSelect;
export type InfraTrustedDeviceRow = typeof infraTrustedDevices.$inferSelect;
