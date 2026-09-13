/**
 * ES256 keypairs used to sign access tokens.
 *
 * The private key is stored with the same AES-256-GCM envelope as tenant connection strings:
 * a leak of the Master DB alone must not let anyone mint tokens.
 */
import { index, integer, jsonb, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';

export const SIGNING_KEY_STATUSES = ['active', 'retiring', 'retired'] as const;
export type SigningKeyStatus = (typeof SIGNING_KEY_STATUSES)[number];

export const infraSigningKeys = pgTable(
  'infra_signing_keys',
  {
    kid: varchar('kid', { length: 32 }).primaryKey(),
    algorithm: varchar('algorithm', { length: 16 }).notNull().default('ES256'),

    /** Published at /.well-known/jwks.json — public by design. */
    publicJwk: jsonb('public_jwk').$type<Record<string, unknown>>().notNull(),

    /** AES-256-GCM envelope over the PKCS#8 PEM. AAD = `signing-key:<kid>`. */
    encryptedPrivateKey: text('encrypted_private_key').notNull(),
    encryptionIv: varchar('encryption_iv', { length: 24 }).notNull(),
    encryptionAuthTag: varchar('encryption_auth_tag', { length: 32 }).notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull().default(1),

    status: varchar('status', { length: 16 }).notNull().default('active').$type<SigningKeyStatus>(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    /** While retiring, the key still verifies old tokens but signs nothing new. */
    retiresAt: timestamp('retires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_signing_keys_status_idx').on(t.status)],
);

export type InfraSigningKeyRow = typeof infraSigningKeys.$inferSelect;
export type NewInfraSigningKey = typeof infraSigningKeys.$inferInsert;
