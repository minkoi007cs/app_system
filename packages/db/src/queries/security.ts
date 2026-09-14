/**
 * Sign-in throttling and account recovery, against the Master DB.
 *
 * The policy lives in @infra/core as pure functions; this file is only the state. That split is
 * what lets the lockout curve be tested exhaustively without a database, and keeps the SQL here
 * boring enough to read in one sitting.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  afterFailure,
  evaluateAttempt,
  generateRecoveryToken,
  hashRecoveryToken,
  InfraError,
  isRecoveryTokenValid,
  loginScopeKey,
  LOGIN_SCOPES,
  POLICY_FOR,
  recoveryExpiry,
  strictest,
  type AttemptState,
  type LoginScope,
  type ThrottleVerdict,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraLoginAttempts,
  infraRecoveryTokens,
  type InfraRecoveryTokenRow,
} from '../schema/security.js';
import { infraRefreshTokens } from '../schema/refresh-tokens.js';
import { infraTrustedDevices } from '../schema/mfa.js';
import { session } from '../schema/auth.js';

// ── throttling ───────────────────────────────────────────────────────────────

export interface LoginIdentity {
  ip: string | null;
  email: string | null;
}

async function readState(db: MasterDatabase, scope: LoginScope, keyHash: string): Promise<AttemptState> {
  const [row] = await db
    .select()
    .from(infraLoginAttempts)
    .where(and(eq(infraLoginAttempts.scope, scope), eq(infraLoginAttempts.keyHash, keyHash)))
    .limit(1);

  if (row === undefined) return { failureCount: 0, lastFailureAt: null, lockedUntil: null };
  return { failureCount: row.failureCount, lastFailureAt: row.lastFailureAt, lockedUntil: row.lockedUntil };
}

/**
 * Asks both scopes and returns the stricter answer. Called before the password is ever verified,
 * so a locked-out caller costs one indexed read rather than a password hash.
 */
export async function checkLoginThrottle(
  db: MasterDatabase,
  identity: LoginIdentity,
  now: Date = new Date(),
): Promise<ThrottleVerdict> {
  const verdicts = await Promise.all(
    LOGIN_SCOPES.map(async (scope) => {
      const state = await readState(db, scope, loginScopeKey(scope, identity.ip, identity.email));
      return evaluateAttempt(state, POLICY_FOR[scope], now);
    }),
  );

  return strictest(verdicts);
}

/** Increments both counters and writes the new lockout window. Never throws on a missing row. */
export async function recordLoginFailure(
  db: MasterDatabase,
  identity: LoginIdentity,
  now: Date = new Date(),
): Promise<ThrottleVerdict> {
  const verdicts: ThrottleVerdict[] = [];

  for (const scope of LOGIN_SCOPES) {
    const keyHash = loginScopeKey(scope, identity.ip, identity.email);
    const policy = POLICY_FOR[scope];
    const next = afterFailure(await readState(db, scope, keyHash), policy, now);

    await db
      .insert(infraLoginAttempts)
      .values({
        scope,
        keyHash,
        failureCount: next.failureCount,
        firstFailureAt: now,
        lastFailureAt: now,
        lockedUntil: next.lockedUntil,
      })
      .onConflictDoUpdate({
        target: [infraLoginAttempts.scope, infraLoginAttempts.keyHash],
        set: {
          failureCount: next.failureCount,
          lastFailureAt: now,
          lockedUntil: next.lockedUntil,
        },
      });

    verdicts.push(evaluateAttempt(next, policy, now));
  }

  return strictest(verdicts);
}

/**
 * Clears the counters after a correct password.
 *
 * Only the (IP, email) counter is cleared, never the IP-wide one: a stuffing run that happens to
 * guess one account right must not reset the budget it has been burning on everybody else.
 */
export async function clearLoginFailures(db: MasterDatabase, identity: LoginIdentity): Promise<void> {
  await db
    .delete(infraLoginAttempts)
    .where(
      and(
        eq(infraLoginAttempts.scope, 'ip_email'),
        eq(infraLoginAttempts.keyHash, loginScopeKey('ip_email', identity.ip, identity.email)),
      ),
    );
}

/** Housekeeping: counters older than the longest TTL carry no information. */
export async function sweepLoginAttempts(
  db: MasterDatabase,
  olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000),
): Promise<number> {
  const removed = await db
    .delete(infraLoginAttempts)
    .where(lt(infraLoginAttempts.lastFailureAt, olderThan))
    .returning({ id: infraLoginAttempts.id });
  return removed.length;
}

// ── recovery tokens ──────────────────────────────────────────────────────────

export interface IssuedRecoveryToken {
  row: InfraRecoveryTokenRow;
  /** Put this in the link, mail it, then forget it. */
  token: string;
}

/**
 * Issues one token and invalidates every other outstanding one for that user, so a person who
 * clicks "forgot password" three times cannot be reset by whoever intercepted the first mail.
 */
export async function issueRecoveryToken(
  db: MasterDatabase,
  userId: string,
  options: { ttlMinutes?: number | undefined; requestedIp?: string | null | undefined } = {},
): Promise<IssuedRecoveryToken> {
  const now = new Date();

  await db
    .update(infraRecoveryTokens)
    .set({ usedAt: now })
    .where(and(eq(infraRecoveryTokens.userId, userId), isNull(infraRecoveryTokens.usedAt)));

  const generated = generateRecoveryToken();
  const [row] = await db
    .insert(infraRecoveryTokens)
    .values({
      userId,
      tokenHash: generated.hash,
      expiresAt: recoveryExpiry(options.ttlMinutes, now),
      requestedIp: options.requestedIp ?? null,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'recovery token insert returned no row');
  return { row, token: generated.raw };
}

/** Read-only: is this token live? Used to validate the new password before burning anything. */
export async function peekRecoveryToken(
  db: MasterDatabase,
  raw: string,
  now: Date = new Date(),
): Promise<InfraRecoveryTokenRow> {
  if (!isRecoveryTokenValid(raw)) {
    throw new InfraError('VALIDATION_FAILED', 'that recovery link is malformed');
  }

  const [row] = await db
    .select()
    .from(infraRecoveryTokens)
    .where(eq(infraRecoveryTokens.tokenHash, hashRecoveryToken(raw)))
    .limit(1);

  if (row === undefined) throw new InfraError('VALIDATION_FAILED', 'that recovery link is not valid');
  if (row.usedAt !== null) throw new InfraError('VALIDATION_FAILED', 'that recovery link was already used');
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new InfraError('VALIDATION_FAILED', 'that recovery link has expired');
  }

  return row;
}

/**
 * Burns the token and returns the user it belonged to.
 *
 * The burn is a single UPDATE ... WHERE used_at IS NULL RETURNING, so of two concurrent
 * redemptions exactly one gets a row back and the other gets nothing. Anything short of that —
 * SELECT then UPDATE — is a race that hands out two valid resets from one link.
 */
export async function consumeRecoveryToken(
  db: MasterDatabase,
  raw: string,
  options: { consumedIp?: string | null | undefined; now?: Date | undefined } = {},
): Promise<InfraRecoveryTokenRow> {
  if (!isRecoveryTokenValid(raw)) {
    throw new InfraError('VALIDATION_FAILED', 'that recovery link is malformed');
  }

  const now = options.now ?? new Date();
  const [row] = await db
    .update(infraRecoveryTokens)
    .set({ usedAt: now, consumedIp: options.consumedIp ?? null })
    .where(
      and(
        eq(infraRecoveryTokens.tokenHash, hashRecoveryToken(raw)),
        isNull(infraRecoveryTokens.usedAt),
        sql`${infraRecoveryTokens.expiresAt} > ${now}`,
      ),
    )
    .returning();

  if (row === undefined) {
    // Deliberately one message for "wrong", "already used" and "expired": a caller holding a
    // stolen link learns nothing about why it failed.
    throw new InfraError('VALIDATION_FAILED', 'that recovery link is no longer valid');
  }

  return row;
}

export interface CredentialRevocation {
  refreshTokensRevoked: number;
  sessionsRemoved: number;
  trustedDevicesRemoved: number;
  recoveryTokensInvalidated: number;
}

/**
 * What a password change has to do beyond writing the new hash.
 *
 * If the old password was compromised, the attacker most likely holds a live session and a refresh
 * token too. Changing the password without this call leaves them signed in — the single most
 * common way a "recovered" account stays owned.
 */
export async function revokeAllUserCredentials(
  db: MasterDatabase,
  userId: string,
  reason: 'password_reset' | 'offboard' = 'password_reset',
  now: Date = new Date(),
): Promise<CredentialRevocation> {
  const refreshTokens = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(infraRefreshTokens.userId, userId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });

  const sessions = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });

  const devices = await db
    .delete(infraTrustedDevices)
    .where(eq(infraTrustedDevices.userId, userId))
    .returning({ id: infraTrustedDevices.id });

  const recovery = await db
    .update(infraRecoveryTokens)
    .set({ usedAt: now })
    .where(and(eq(infraRecoveryTokens.userId, userId), isNull(infraRecoveryTokens.usedAt)))
    .returning({ id: infraRecoveryTokens.id });

  return {
    refreshTokensRevoked: refreshTokens.length,
    sessionsRemoved: sessions.length,
    trustedDevicesRemoved: devices.length,
    recoveryTokensInvalidated: recovery.length,
  };
}
