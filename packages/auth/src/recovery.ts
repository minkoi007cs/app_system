/**
 * Account recovery.
 *
 * Better Auth owns the password hash and the `account` row, so this never writes either directly:
 * it goes through `auth.$context`, using the same `password.hash` and `internalAdapter` calls the
 * library's own reset route uses. Hand-rolling the write here would mean picking a hash algorithm
 * a second time and getting it wrong the second time.
 *
 * What is ours is everything around it — the token (see @infra/core recovery.ts), the atomic burn,
 * the password assessment, and the revocation sweep afterwards.
 *
 * The order of operations matters and is not the obvious one:
 *
 *   1. peek   — is the link live? (read-only; a dead link costs no outbound request)
 *   2. assess — is the new password acceptable? (a weak password must not consume the link, or a
 *               legitimate person who picks a bad password is locked out of their own recovery)
 *   3. burn   — atomic, single winner
 *   4. write  — new hash
 *   5. revoke — every session, refresh token and remembered device
 *
 * Step 5 is the one people leave out. If the account was taken over, the attacker is holding a live
 * session; changing the password without revoking it recovers nothing.
 */
import {
  assessPassword,
  InfraError,
  normaliseEmail,
  type AssessPasswordOptions,
  type PasswordAssessment,
} from '@infra/core';
import {
  consumeRecoveryToken,
  emitToUserAppsAsync,
  issueRecoveryToken,
  peekRecoveryToken,
  revokeAllUserCredentials,
  type CredentialRevocation,
  type MasterDatabase,
} from '@infra/db';
import type { Auth } from './server.js';

export interface RecoveryRequestInput {
  email: string;
  ip?: string | null;
  ttlMinutes?: number;
}

export interface RecoveryRequestResult {
  /** False when no account matches. The HTTP layer must answer identically either way. */
  issued: boolean;
  userId: string | null;
  /** Present only when issued. Goes straight into the mail; never into a response body or a log. */
  token: string | null;
}

export async function requestPasswordRecovery(
  auth: Auth,
  db: MasterDatabase,
  input: RecoveryRequestInput,
): Promise<RecoveryRequestResult> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(normaliseEmail(input.email));

  if (found === null) return { issued: false, userId: null, token: null };

  const issued = await issueRecoveryToken(db, found.user.id, {
    ttlMinutes: input.ttlMinutes,
    requestedIp: input.ip ?? null,
  });

  return { issued: true, userId: found.user.id, token: issued.token };
}

export interface RecoveryCompletionInput {
  token: string;
  newPassword: string;
  ip?: string | null;
  passwordOptions?: AssessPasswordOptions;
}

export interface RecoveryCompletionResult {
  userId: string;
  assessment: PasswordAssessment;
  revoked: CredentialRevocation;
}

export async function completePasswordRecovery(
  auth: Auth,
  db: MasterDatabase,
  input: RecoveryCompletionInput,
): Promise<RecoveryCompletionResult> {
  const context = await auth.$context;

  // 1 — is the link live at all?
  const peeked = await peekRecoveryToken(db, input.token);
  const account = await context.internalAdapter.findUserById(peeked.userId);
  if (account === null) {
    throw new InfraError('VALIDATION_FAILED', 'that recovery link is no longer valid');
  }

  // 2 — assess before burning, so a rejected password leaves the link usable.
  const assessment = await assessPassword(input.newPassword, {
    ...input.passwordOptions,
    identifiers: [account.email, account.name ?? '', ...(input.passwordOptions?.identifiers ?? [])],
  });

  if (!assessment.ok) {
    throw new InfraError('VALIDATION_FAILED', assessment.problems[0]?.message ?? 'password rejected', {
      details: { problems: assessment.problems.map((problem) => problem.code) },
    });
  }

  // 3 — atomic burn. Losing this race means someone else already redeemed the link.
  const consumed = await consumeRecoveryToken(db, input.token, { consumedIp: input.ip ?? null });

  // 4 — write the hash through Better Auth, creating the credential account if the user has only
  //     ever signed in with OAuth until now.
  const hash = await context.password.hash(input.newPassword);
  const credential = await context.internalAdapter.findCredentialAccount(consumed.userId);

  if (credential === null) {
    await context.internalAdapter.createAccount({
      userId: consumed.userId,
      providerId: 'credential',
      accountId: consumed.userId,
      password: hash,
    });
  } else {
    await context.internalAdapter.updatePassword(consumed.userId, hash);
  }

  // Clicking a link sent to the address proves control of the mailbox — the same thing email
  // verification proves, so there is nothing left to verify separately.
  if (!account.emailVerified) {
    await context.internalAdapter.updateUser(consumed.userId, { emailVerified: true });
  }

  // 5 — nothing the previous password could reach stays reachable.
  const revoked = await revokeAllUserCredentials(db, consumed.userId, 'password_reset');

  // Child apps care: a password reset is the signal to drop any cached session of their own.
  emitToUserAppsAsync(db, consumed.userId, 'user.password_reset', {
    userId: consumed.userId,
    sessionsRevoked: revoked.sessionsRemoved,
  });

  return { userId: consumed.userId, assessment, revoked };
}
