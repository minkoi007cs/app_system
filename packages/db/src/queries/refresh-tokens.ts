/**
 * Refresh token rotation with reuse detection.
 *
 * The security property this file exists for: stealing a refresh token buys an attacker at most
 * one rotation. The moment either party presents an already-used token, the whole family dies and
 * the legitimate user is logged out everywhere — noisy on purpose, because silent theft is worse.
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import {
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  InfraError,
  isRefreshTokenFormatValid,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraRefreshTokens,
  type InfraRefreshTokenRow,
  type RefreshRevokeReason,
} from '../schema/refresh-tokens.js';

export interface IssueRefreshTokenInput {
  userId: string;
  appId: string;
  sessionId: string;
  /** Continue an existing family on rotation; omit to start a new one (a fresh login). */
  familyId?: string;
  ttlSeconds?: number;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface IssuedRefreshToken {
  /** Hand to the caller once. Never logged. */
  raw: string;
  row: InfraRefreshTokenRow;
  expiresAt: Date;
}

export async function issueRefreshToken(
  db: MasterDatabase,
  input: IssueRefreshTokenInput,
): Promise<IssuedRefreshToken> {
  const generated = generateRefreshToken(input.familyId);
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS) * 1000);

  const [row] = await db
    .insert(infraRefreshTokens)
    .values({
      tokenHash: generated.hash,
      familyId: generated.familyId,
      userId: input.userId,
      appId: input.appId,
      sessionId: input.sessionId,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'refresh token insert returned no row');
  return { raw: generated.raw, row, expiresAt };
}

/** Kills every token in a family — used on reuse detection and on logout-everywhere. */
export async function revokeFamily(
  db: MasterDatabase,
  familyId: string,
  reason: RefreshRevokeReason,
): Promise<number> {
  const revoked = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(infraRefreshTokens.familyId, familyId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });
  return revoked.length;
}

export async function revokeAllForUser(
  db: MasterDatabase,
  userId: string,
  reason: RefreshRevokeReason = 'offboard',
): Promise<number> {
  const revoked = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(infraRefreshTokens.userId, userId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });
  return revoked.length;
}

export async function revokeSession(
  db: MasterDatabase,
  sessionId: string,
  reason: RefreshRevokeReason = 'logout',
): Promise<number> {
  const revoked = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(infraRefreshTokens.sessionId, sessionId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });
  return revoked.length;
}

export interface RotationOutcome {
  raw: string;
  row: InfraRefreshTokenRow;
  previous: InfraRefreshTokenRow;
  expiresAt: Date;
}

/**
 * Verifies, burns and replaces a refresh token.
 *
 * Order matters: a token that is present but already used is the dangerous case, so it is checked
 * before expiry and before anything else that could return a softer error.
 */
export async function rotateRefreshToken(
  db: MasterDatabase,
  rawToken: string,
  context: { userAgent?: string | null; ipAddress?: string | null } = {},
  now: Date = new Date(),
): Promise<RotationOutcome> {
  if (!isRefreshTokenFormatValid(rawToken)) {
    throw new InfraError('UNAUTHENTICATED', 'refresh token is malformed');
  }

  const [existing] = await db
    .select()
    .from(infraRefreshTokens)
    .where(eq(infraRefreshTokens.tokenHash, hashRefreshToken(rawToken)))
    .limit(1);

  if (existing === undefined) {
    throw new InfraError('UNAUTHENTICATED', 'refresh token is not recognised');
  }

  // ── the reason this module exists ──────────────────────────────────────────
  if (existing.usedAt !== null) {
    const killed = await revokeFamily(db, existing.familyId, 'reuse_detected');
    throw new InfraError(
      'UNAUTHENTICATED',
      'refresh token was already used — every session in this family has been revoked',
      { details: { familyId: existing.familyId, revokedCount: killed, reuseDetected: true } },
    );
  }

  if (existing.revokedAt !== null) {
    throw new InfraError('UNAUTHENTICATED', 'refresh token has been revoked');
  }
  if (existing.expiresAt.getTime() <= now.getTime()) {
    throw new InfraError('UNAUTHENTICATED', 'refresh token has expired');
  }

  // Burn first, then mint: if the insert fails, the old token is already dead — fail closed.
  await db
    .update(infraRefreshTokens)
    .set({ usedAt: now, revokedAt: now, revokedReason: 'rotated' })
    .where(eq(infraRefreshTokens.id, existing.id));

  const issued = await issueRefreshToken(db, {
    userId: existing.userId,
    appId: existing.appId,
    sessionId: existing.sessionId,
    familyId: existing.familyId,
    userAgent: context.userAgent ?? existing.userAgent,
    ipAddress: context.ipAddress ?? existing.ipAddress,
  });

  return { raw: issued.raw, row: issued.row, previous: existing, expiresAt: issued.expiresAt };
}

/** Looks a token up by hash — the raw value is never compared or stored anywhere. */
export async function findRefreshTokenByHash(
  db: MasterDatabase,
  rawToken: string,
): Promise<InfraRefreshTokenRow | null> {
  if (!isRefreshTokenFormatValid(rawToken)) return null;
  const [row] = await db
    .select()
    .from(infraRefreshTokens)
    .where(eq(infraRefreshTokens.tokenHash, hashRefreshToken(rawToken)))
    .limit(1);
  return row ?? null;
}

/** Sessions a user currently has on an app, newest first — powers the device list in Phase 5.11. */
export async function listActiveRefreshTokens(
  db: MasterDatabase,
  userId: string,
): Promise<InfraRefreshTokenRow[]> {
  return db
    .select()
    .from(infraRefreshTokens)
    .where(and(eq(infraRefreshTokens.userId, userId), isNull(infraRefreshTokens.revokedAt)));
}

export async function purgeExpiredRefreshTokens(db: MasterDatabase, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(infraRefreshTokens)
    .where(lt(infraRefreshTokens.expiresAt, now))
    .returning({ id: infraRefreshTokens.id });
  return removed.length;
}
