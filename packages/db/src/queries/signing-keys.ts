/**
 * Lifecycle of the token-signing keys.
 *
 * A private key exists in plaintext only inside this module, for the moment it takes to sign —
 * it is never returned to a route handler, never logged, never serialised.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  decryptSecret,
  encryptSecret,
  generateSigningKeyPair,
  InfraError,
  type SigningKeyMaterial,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraSigningKeys, type InfraSigningKeyRow } from '../schema/signing-keys.js';

/** Binds a ciphertext to the exact key row that owns it. */
export function signingKeyAad(kid: string): string {
  return `signing-key:${kid}`;
}

export interface PublicSigningKey {
  kid: string;
  jwk: Record<string, unknown>;
  status: string;
}

/** Creates a new keypair, encrypts the private half and stores it. */
export async function provisionSigningKey(db: MasterDatabase): Promise<PublicSigningKey> {
  const generated = generateSigningKeyPair();
  const sealed = encryptSecret(generated.privateKeyPem, signingKeyAad(generated.kid));

  const [row] = await db
    .insert(infraSigningKeys)
    .values({
      kid: generated.kid,
      algorithm: 'ES256',
      publicJwk: generated.publicJwk as unknown as Record<string, unknown>,
      encryptedPrivateKey: sealed.ciphertext,
      encryptionIv: sealed.iv,
      encryptionAuthTag: sealed.authTag,
      encryptionKeyVersion: sealed.keyVersion,
      status: 'active',
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'signing key insert returned no row');
  return { kid: row.kid, jwk: row.publicJwk, status: row.status };
}

async function loadActiveRow(db: MasterDatabase): Promise<InfraSigningKeyRow | null> {
  const [row] = await db
    .select()
    .from(infraSigningKeys)
    .where(eq(infraSigningKeys.status, 'active'))
    .orderBy(desc(infraSigningKeys.notBefore))
    .limit(1);
  return row ?? null;
}

/** The key new tokens are signed with. Creates one on first call so a fresh install just works. */
export async function getActiveSigningKey(db: MasterDatabase): Promise<SigningKeyMaterial> {
  let row = await loadActiveRow(db);
  if (row === null) {
    await provisionSigningKey(db);
    row = await loadActiveRow(db);
  }
  if (row === null) throw new InfraError('INTERNAL', 'no active signing key available');

  const privateKeyPem = decryptSecret(
    {
      ciphertext: row.encryptedPrivateKey,
      iv: row.encryptionIv,
      authTag: row.encryptionAuthTag,
      keyVersion: row.encryptionKeyVersion,
    },
    signingKeyAad(row.kid),
  );

  return { kid: row.kid, privateKeyPem };
}

/**
 * Every key a verifier should still trust: the active one plus those being retired.
 * Retiring keys stay here long enough for the last tokens they signed to expire.
 */
export async function listPublicSigningKeys(db: MasterDatabase): Promise<PublicSigningKey[]> {
  const rows = await db
    .select()
    .from(infraSigningKeys)
    .where(inArray(infraSigningKeys.status, ['active', 'retiring']))
    .orderBy(desc(infraSigningKeys.notBefore));

  return rows.map((row) => ({ kid: row.kid, jwk: row.publicJwk, status: row.status }));
}

export interface RotationResult {
  newKid: string;
  retiredKid: string | null;
}

/**
 * Rotation: mint a new active key, mark the old one 'retiring' until `retireAfterSeconds`.
 * Never delete a key immediately — tokens it signed are still in flight.
 */
export async function rotateSigningKey(
  db: MasterDatabase,
  retireAfterSeconds = 24 * 60 * 60,
): Promise<RotationResult> {
  const previous = await loadActiveRow(db);
  const created = await provisionSigningKey(db);

  if (previous !== null) {
    await db
      .update(infraSigningKeys)
      .set({ status: 'retiring', retiresAt: new Date(Date.now() + retireAfterSeconds * 1000) })
      .where(eq(infraSigningKeys.kid, previous.kid));
  }

  return { newKid: created.kid, retiredKid: previous?.kid ?? null };
}

/** Housekeeping: drop keys whose retirement window has passed. */
export async function purgeRetiredSigningKeys(db: MasterDatabase, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ kid: infraSigningKeys.kid, retiresAt: infraSigningKeys.retiresAt })
    .from(infraSigningKeys)
    .where(eq(infraSigningKeys.status, 'retiring'));

  const expired = rows.filter((row) => row.retiresAt !== null && row.retiresAt.getTime() <= now.getTime());
  for (const row of expired) {
    await db
      .update(infraSigningKeys)
      .set({ status: 'retired' })
      .where(and(eq(infraSigningKeys.kid, row.kid), eq(infraSigningKeys.status, 'retiring')));
  }
  return expired.length;
}
