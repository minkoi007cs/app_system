/** Challenge storage + passkey factor rows. */
import { and, eq, lt } from 'drizzle-orm';
import { InfraError } from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraMfaFactors, type InfraMfaFactorRow } from '../schema/mfa.js';
import {
  infraWebauthnChallenges,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
  type InfraWebauthnChallengeRow,
} from '../schema/webauthn.js';

export type ChallengePurpose = 'register' | 'authenticate';

export async function storeChallenge(
  db: MasterDatabase,
  userId: string,
  purpose: ChallengePurpose,
  challenge: string,
): Promise<InfraWebauthnChallengeRow> {
  const [row] = await db
    .insert(infraWebauthnChallenges)
    .values({
      userId,
      purpose,
      challenge,
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000),
    })
    .returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'challenge insert returned no row');
  return row;
}

/**
 * Reads a challenge and burns it in the same step. A challenge that is expired, already used or
 * belongs to a different purpose is refused — replaying a captured assertion must not work.
 */
export async function consumeChallenge(
  db: MasterDatabase,
  userId: string,
  purpose: ChallengePurpose,
  now: Date = new Date(),
): Promise<string> {
  const rows = await db
    .select()
    .from(infraWebauthnChallenges)
    .where(and(eq(infraWebauthnChallenges.userId, userId), eq(infraWebauthnChallenges.purpose, purpose)));

  const usable = rows
    .filter((row) => row.consumedAt === null && row.expiresAt.getTime() > now.getTime())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (usable === undefined) throw new InfraError('UNAUTHENTICATED', 'challenge expired — start again');

  await db
    .update(infraWebauthnChallenges)
    .set({ consumedAt: now })
    .where(eq(infraWebauthnChallenges.id, usable.id));

  return usable.challenge;
}

export async function purgeExpiredChallenges(db: MasterDatabase, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(infraWebauthnChallenges)
    .where(lt(infraWebauthnChallenges.expiresAt, now))
    .returning({ id: infraWebauthnChallenges.id });
  return removed.length;
}

export interface PasskeyRecord {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
}

export async function listPasskeys(db: MasterDatabase, userId: string): Promise<InfraMfaFactorRow[]> {
  const rows = await db.select().from(infraMfaFactors).where(eq(infraMfaFactors.userId, userId));
  return rows.filter((row) => row.type === 'webauthn' && row.verifiedAt !== null);
}

export async function savePasskey(
  db: MasterDatabase,
  userId: string,
  record: PasskeyRecord,
  now: Date = new Date(),
): Promise<InfraMfaFactorRow> {
  const [row] = await db
    .insert(infraMfaFactors)
    .values({
      userId,
      type: 'webauthn',
      label: record.label,
      credentialId: record.credentialId,
      publicKey: record.publicKey,
      signCount: record.counter,
      transports: record.transports,
      verifiedAt: now,
      lastUsedAt: now,
    })
    .returning();
  if (row === undefined) throw new InfraError('INTERNAL', 'passkey insert returned no row');
  return row;
}

export async function findPasskeyByCredentialId(
  db: MasterDatabase,
  credentialId: string,
): Promise<InfraMfaFactorRow | null> {
  const [row] = await db
    .select()
    .from(infraMfaFactors)
    .where(and(eq(infraMfaFactors.credentialId, credentialId), eq(infraMfaFactors.type, 'webauthn')))
    .limit(1);
  return row ?? null;
}

/**
 * The signature counter must never go backwards. If it does, the same credential exists in two
 * places — a cloned authenticator — and the factor is disabled rather than trusted.
 */
export async function updatePasskeyCounter(
  db: MasterDatabase,
  factorId: string,
  newCounter: number,
  previousCounter: number,
): Promise<void> {
  if (newCounter !== 0 && previousCounter !== 0 && newCounter <= previousCounter) {
    await db.update(infraMfaFactors).set({ verifiedAt: null }).where(eq(infraMfaFactors.id, factorId));
    throw new InfraError('UNAUTHENTICATED', 'this passkey looks cloned — it has been disabled', {
      details: { factorId, reason: 'counter_regression' },
    });
  }

  await db
    .update(infraMfaFactors)
    .set({ signCount: newCounter, lastUsedAt: new Date() })
    .where(eq(infraMfaFactors.id, factorId));
}
