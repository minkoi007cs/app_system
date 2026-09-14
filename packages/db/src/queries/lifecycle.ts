/**
 * Join → transfer → leave.
 *
 * Offboarding is the one that matters: the moment someone leaves, every credential they hold has
 * to stop working — sessions, refresh tokens, role grants, remembered devices. A "disabled" flag
 * that leaves a live refresh token behind is not offboarding, it is a false sense of one.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  DEFAULT_INVITATION_TTL_HOURS,
  generateInvitationToken,
  hashInvitationToken,
  InfraError,
  isInvitationTokenValid,
  normaliseEmail,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import {
  infraInvitations,
  infraUserLifecycle,
  type InfraInvitationRow,
  type InfraUserLifecycleRow,
  type UserStatus,
} from '../schema/lifecycle.js';
import { infraAppMembers, user } from '../schema/auth.js';
import { infraRoleAssignments } from '../schema/access.js';
import { infraRefreshTokens } from '../schema/refresh-tokens.js';
import { infraTrustedDevices } from '../schema/mfa.js';
import { session } from '../schema/auth.js';
import { emitToUserAppsAsync } from './webhooks.js';

// ── invitations ──────────────────────────────────────────────────────────────

export interface InviteInput {
  appId: string;
  email: string;
  role?: string;
  invitedBy: string;
  ttlHours?: number;
}

export interface IssuedInvitation {
  row: InfraInvitationRow;
  /** Put this in the link. It is never stored and cannot be recovered. */
  token: string;
}

export async function inviteMember(db: MasterDatabase, input: InviteInput): Promise<IssuedInvitation> {
  const generated = generateInvitationToken();
  const [row] = await db
    .insert(infraInvitations)
    .values({
      appId: input.appId,
      email: normaliseEmail(input.email),
      role: input.role ?? 'member',
      tokenHash: generated.hash,
      invitedBy: input.invitedBy,
      expiresAt: new Date(Date.now() + (input.ttlHours ?? DEFAULT_INVITATION_TTL_HOURS) * 3600 * 1000),
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'invitation insert returned no row');
  return { row, token: generated.raw };
}

export async function listInvitations(db: MasterDatabase, appId: string): Promise<InfraInvitationRow[]> {
  return db.select().from(infraInvitations).where(eq(infraInvitations.appId, appId));
}

export async function revokeInvitation(db: MasterDatabase, invitationId: string): Promise<void> {
  await db
    .update(infraInvitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(infraInvitations.id, invitationId), isNull(infraInvitations.acceptedAt)));
}

export interface AcceptedInvitation {
  appId: string;
  role: string;
}

/**
 * Accepting binds the invitation to the signed-in user. The email on the account must match the
 * email that was invited — otherwise forwarding the link would hand the membership to whoever
 * opened it.
 */
export async function acceptInvitation(
  db: MasterDatabase,
  token: string,
  acceptingUserId: string,
  acceptingEmail: string,
  now: Date = new Date(),
): Promise<AcceptedInvitation> {
  if (!isInvitationTokenValid(token)) {
    throw new InfraError('VALIDATION_FAILED', 'that invitation link is malformed');
  }

  const [invitation] = await db
    .select()
    .from(infraInvitations)
    .where(eq(infraInvitations.tokenHash, hashInvitationToken(token)))
    .limit(1);

  if (invitation === undefined) throw new InfraError('VALIDATION_FAILED', 'invitation not found');
  if (invitation.revokedAt !== null) throw new InfraError('VALIDATION_FAILED', 'invitation was revoked');
  if (invitation.acceptedAt !== null) throw new InfraError('VALIDATION_FAILED', 'invitation was already used');
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new InfraError('VALIDATION_FAILED', 'invitation has expired');
  }
  if (invitation.email !== normaliseEmail(acceptingEmail)) {
    throw new InfraError('FORBIDDEN_SCOPE', 'this invitation was sent to a different email address');
  }

  await db
    .update(infraInvitations)
    .set({ acceptedAt: now, acceptedBy: acceptingUserId })
    .where(eq(infraInvitations.id, invitation.id));

  await db
    .insert(infraAppMembers)
    .values({ appId: invitation.appId, userId: acceptingUserId, role: invitation.role as 'member' })
    .onConflictDoNothing();

  emitToUserAppsAsync(db, acceptingUserId, 'member.joined', {
    userId: acceptingUserId,
    appId: invitation.appId,
    role: invitation.role,
  });

  return { appId: invitation.appId, role: invitation.role };
}

// ── status ───────────────────────────────────────────────────────────────────

export async function getUserStatus(db: MasterDatabase, userId: string): Promise<UserStatus> {
  const [row] = await db
    .select()
    .from(infraUserLifecycle)
    .where(eq(infraUserLifecycle.userId, userId))
    .limit(1);
  return row?.status ?? 'active';
}

async function setStatus(
  db: MasterDatabase,
  userId: string,
  status: UserStatus,
  changedBy: string,
  reason: string | null,
  extra: Partial<InfraUserLifecycleRow> = {},
): Promise<void> {
  await db
    .insert(infraUserLifecycle)
    .values({ userId, status, changedBy, reason, updatedAt: new Date(), ...extra })
    .onConflictDoUpdate({
      target: infraUserLifecycle.userId,
      set: { status, changedBy, reason, updatedAt: new Date(), ...extra },
    });
}

export interface OffboardResult {
  refreshTokensRevoked: number;
  sessionsRemoved: number;
  roleAssignmentsRemoved: number;
  trustedDevicesRemoved: number;
}

/**
 * Everything a departing person holds, revoked in one call.
 * Deliberately does NOT delete the user row: audit history must keep pointing somewhere.
 */
export async function offboardUser(
  db: MasterDatabase,
  userId: string,
  changedBy: string,
  reason: string | null = null,
  now: Date = new Date(),
): Promise<OffboardResult> {
  const refreshTokens = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: now, revokedReason: 'offboard' })
    .where(and(eq(infraRefreshTokens.userId, userId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });

  const sessions = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });

  const assignments = await db
    .delete(infraRoleAssignments)
    .where(and(eq(infraRoleAssignments.subjectType, 'user'), eq(infraRoleAssignments.subjectId, userId)))
    .returning({ id: infraRoleAssignments.id });

  const devices = await db
    .delete(infraTrustedDevices)
    .where(eq(infraTrustedDevices.userId, userId))
    .returning({ id: infraTrustedDevices.id });

  await setStatus(db, userId, 'offboarded', changedBy, reason, { offboardedAt: now });

  // Emitted after the revocations, never before: a child app that reacts by deleting local data
  // must not be told the person is gone while their token still works.
  emitToUserAppsAsync(db, userId, 'user.offboarded', { userId, reason });

  return {
    refreshTokensRevoked: refreshTokens.length,
    sessionsRemoved: sessions.length,
    roleAssignmentsRemoved: assignments.length,
    trustedDevicesRemoved: devices.length,
  };
}

export async function suspendUser(
  db: MasterDatabase,
  userId: string,
  changedBy: string,
  reason: string | null = null,
  now: Date = new Date(),
): Promise<number> {
  // Suspension is reversible, so credentials are revoked but grants are left in place.
  const revoked = await db
    .update(infraRefreshTokens)
    .set({ revokedAt: now, revokedReason: 'offboard' })
    .where(and(eq(infraRefreshTokens.userId, userId), isNull(infraRefreshTokens.revokedAt)))
    .returning({ id: infraRefreshTokens.id });

  await db.delete(session).where(eq(session.userId, userId));
  await setStatus(db, userId, 'suspended', changedBy, reason, { suspendedAt: now });
  emitToUserAppsAsync(db, userId, 'user.suspended', { userId, reason });
  return revoked.length;
}

export async function reinstateUser(db: MasterDatabase, userId: string, changedBy: string): Promise<void> {
  await setStatus(db, userId, 'active', changedBy, null, { suspendedAt: null, offboardedAt: null });
  emitToUserAppsAsync(db, userId, 'user.reinstated', { userId });
}

/** Marks for deletion after a grace period rather than destroying data immediately. */
export async function requestDeletion(
  db: MasterDatabase,
  userId: string,
  changedBy: string,
  graceDays = 30,
): Promise<Date> {
  const purgeAfter = new Date(Date.now() + graceDays * 24 * 3600 * 1000);
  await offboardUser(db, userId, changedBy, 'deletion requested');
  await setStatus(db, userId, 'pending_deletion', changedBy, 'deletion requested', { purgeAfter });
  return purgeAfter;
}

/** Moves a member between apps, carrying their role but never their credentials. */
export async function transferMembership(
  db: MasterDatabase,
  userId: string,
  fromAppId: string,
  toAppId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<void> {
  await db
    .insert(infraAppMembers)
    .values({ appId: toAppId, userId, role })
    .onConflictDoUpdate({ target: [infraAppMembers.appId, infraAppMembers.userId], set: { role } });

  await db
    .delete(infraAppMembers)
    .where(and(eq(infraAppMembers.appId, fromAppId), eq(infraAppMembers.userId, userId)));

  // Tokens minted for the old app keep their old `aud`, so they stop working there on their own.
  await db
    .update(infraRefreshTokens)
    .set({ revokedAt: new Date(), revokedReason: 'offboard' })
    .where(and(eq(infraRefreshTokens.userId, userId), eq(infraRefreshTokens.appId, fromAppId)));
}

export async function listLifecycle(db: MasterDatabase): Promise<Array<InfraUserLifecycleRow & { email: string }>> {
  return db
    .select({
      userId: infraUserLifecycle.userId,
      status: infraUserLifecycle.status,
      reason: infraUserLifecycle.reason,
      changedBy: infraUserLifecycle.changedBy,
      suspendedAt: infraUserLifecycle.suspendedAt,
      offboardedAt: infraUserLifecycle.offboardedAt,
      purgeAfter: infraUserLifecycle.purgeAfter,
      updatedAt: infraUserLifecycle.updatedAt,
      email: user.email,
    })
    .from(infraUserLifecycle)
    .innerJoin(user, eq(infraUserLifecycle.userId, user.id));
}
