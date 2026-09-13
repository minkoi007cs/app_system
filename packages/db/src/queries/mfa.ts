/**
 * MFA enrolment and verification.
 *
 * A TOTP seed is decrypted only inside this module, only to check one code. The step that
 * produced a valid code is recorded so the same code cannot be replayed within its 90-second
 * acceptance window — without that, someone reading a code over a shoulder has half a minute
 * to use it twice.
 */
import { and, eq } from 'drizzle-orm';
import {
  buildAad,
  decryptSecret,
  encryptSecret,
  findBackupCodeMatch,
  generateBackupCodes,
  generateTotpSecret,
  InfraError,
  TOTP_STEP_SECONDS,
  verifyTotp,
  type BackupCodes,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraMfaFactors, type InfraMfaFactorRow } from '../schema/mfa.js';

function factorAad(factorId: string): string {
  return buildAad('mfa', factorId);
}

export interface StartedTotpEnrolment {
  factorId: string;
  /** Shown once during enrolment so the user can add it to their authenticator app. */
  secretBase32: string;
  otpauthUri: string;
}

export async function startTotpEnrolment(
  db: MasterDatabase,
  userId: string,
  accountName: string,
  issuer: string,
  label = 'Authenticator app',
): Promise<StartedTotpEnrolment> {
  const factorId = crypto.randomUUID();
  const secret = generateTotpSecret({ accountName, issuer });
  const sealed = encryptSecret(secret.base32, factorAad(factorId));

  await db.insert(infraMfaFactors).values({
    id: factorId,
    userId,
    type: 'totp',
    label,
    encryptedSecret: sealed.ciphertext,
    encryptionIv: sealed.iv,
    encryptionAuthTag: sealed.authTag,
    encryptionKeyVersion: sealed.keyVersion,
    // verifiedAt stays null: an unverified factor never satisfies a challenge.
  });

  return { factorId, secretBase32: secret.base32, otpauthUri: secret.uri };
}

function revealSecret(factor: InfraMfaFactorRow): string {
  if (
    factor.encryptedSecret === null ||
    factor.encryptionIv === null ||
    factor.encryptionAuthTag === null
  ) {
    throw new InfraError('INTERNAL', 'factor has no stored secret');
  }
  return decryptSecret(
    {
      ciphertext: factor.encryptedSecret,
      iv: factor.encryptionIv,
      authTag: factor.encryptionAuthTag,
      keyVersion: factor.encryptionKeyVersion ?? 1,
    },
    factorAad(factor.id),
  );
}

export async function listMfaFactors(db: MasterDatabase, userId: string): Promise<InfraMfaFactorRow[]> {
  return db.select().from(infraMfaFactors).where(eq(infraMfaFactors.userId, userId));
}

export async function listVerifiedFactors(db: MasterDatabase, userId: string): Promise<InfraMfaFactorRow[]> {
  const rows = await listMfaFactors(db, userId);
  return rows.filter((row) => row.verifiedAt !== null);
}

export async function hasVerifiedMfa(db: MasterDatabase, userId: string): Promise<boolean> {
  return (await listVerifiedFactors(db, userId)).length > 0;
}

export interface ActivationResult {
  factor: InfraMfaFactorRow;
  /** Returned exactly once, at activation. */
  backupCodes: string[];
}

/** Proves the user's app is in sync, then turns the factor on and issues backup codes. */
export async function activateTotpFactor(
  db: MasterDatabase,
  factorId: string,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<ActivationResult> {
  const [factor] = await db
    .select()
    .from(infraMfaFactors)
    .where(and(eq(infraMfaFactors.id, factorId), eq(infraMfaFactors.userId, userId)))
    .limit(1);

  if (factor === undefined) throw new InfraError('VALIDATION_FAILED', 'enrolment not found');
  if (factor.verifiedAt !== null) throw new InfraError('VALIDATION_FAILED', 'this factor is already active');

  const result = verifyTotp(code, revealSecret(factor), { atMilliseconds: now.getTime() });
  if (!result.valid) throw new InfraError('UNAUTHENTICATED', 'that code is not valid');

  const codes: BackupCodes = generateBackupCodes();
  const existing = await listVerifiedFactors(db, userId);

  const [updated] = await db
    .update(infraMfaFactors)
    .set({
      verifiedAt: now,
      lastUsedAt: now,
      lastUsedStep: Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS) + (result.offset ?? 0),
      backupCodeHashes: codes.hashes,
      isPrimary: existing.length === 0,
    })
    .where(eq(infraMfaFactors.id, factorId))
    .returning();

  if (updated === undefined) throw new InfraError('INTERNAL', 'factor update returned no row');
  return { factor: updated, backupCodes: codes.codes };
}

export type MfaVerificationMethod = 'totp' | 'backup_code';

export interface MfaVerification {
  method: MfaVerificationMethod;
  factorId: string;
  /** How many backup codes are left, after burning one. */
  backupCodesRemaining?: number;
}

/**
 * Checks a code against every verified factor: a TOTP first, then backup codes.
 * A used TOTP step is refused even while it is still inside the drift window.
 */
export async function verifyMfaCode(
  db: MasterDatabase,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<MfaVerification> {
  const factors = await listVerifiedFactors(db, userId);
  if (factors.length === 0) throw new InfraError('UNAUTHENTICATED', 'no active second factor');

  for (const factor of factors) {
    if (factor.type !== 'totp' || factor.encryptedSecret === null) continue;

    const result = verifyTotp(code, revealSecret(factor), { atMilliseconds: now.getTime() });
    if (!result.valid) continue;

    const step = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS) + (result.offset ?? 0);
    if (factor.lastUsedStep !== null && step <= factor.lastUsedStep) {
      throw new InfraError('UNAUTHENTICATED', 'that code has already been used');
    }

    await db
      .update(infraMfaFactors)
      .set({ lastUsedAt: now, lastUsedStep: step })
      .where(eq(infraMfaFactors.id, factor.id));

    return { method: 'totp', factorId: factor.id };
  }

  // Fall back to a backup code, and burn it.
  for (const factor of factors) {
    const index = findBackupCodeMatch(code, factor.backupCodeHashes);
    if (index === -1) continue;

    const remaining = factor.backupCodeHashes.filter((_, position) => position !== index);
    await db
      .update(infraMfaFactors)
      .set({ backupCodeHashes: remaining, lastUsedAt: now })
      .where(eq(infraMfaFactors.id, factor.id));

    return { method: 'backup_code', factorId: factor.id, backupCodesRemaining: remaining.length };
  }

  throw new InfraError('UNAUTHENTICATED', 'that code is not valid');
}

export async function regenerateBackupCodes(
  db: MasterDatabase,
  factorId: string,
  userId: string,
): Promise<string[]> {
  const codes = generateBackupCodes();
  const [updated] = await db
    .update(infraMfaFactors)
    .set({ backupCodeHashes: codes.hashes })
    .where(and(eq(infraMfaFactors.id, factorId), eq(infraMfaFactors.userId, userId)))
    .returning();

  if (updated === undefined) throw new InfraError('VALIDATION_FAILED', 'factor not found');
  return codes.codes;
}

export async function removeMfaFactor(db: MasterDatabase, factorId: string, userId: string): Promise<void> {
  await db
    .delete(infraMfaFactors)
    .where(and(eq(infraMfaFactors.id, factorId), eq(infraMfaFactors.userId, userId)));
}
