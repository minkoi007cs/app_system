/**
 * "Remember this device" for administrator MFA.
 *
 * The device is identified by a random token in an httpOnly cookie — never by a fingerprint of
 * the browser, which is both unreliable and forgeable. Only the token's SHA-256 is stored, so a
 * database leak cannot be replayed as a trusted device.
 */
import { and, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { MasterDatabase } from '../client.js';
import { infraTrustedDevices, type InfraTrustedDeviceRow } from '../schema/mfa.js';

export const TRUSTED_DEVICE_COOKIE = 'infra_trusted_device';
export const TRUSTED_DEVICE_TTL_DAYS = 30;

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

export interface TrustedDeviceGrant {
  /** Goes into the cookie. Never stored. */
  token: string;
  expiresAt: Date;
}

export async function trustDevice(
  db: MasterDatabase,
  userId: string,
  label: string | null = null,
  ttlDays: number = TRUSTED_DEVICE_TTL_DAYS,
): Promise<TrustedDeviceGrant> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await db.insert(infraTrustedDevices).values({
    userId,
    deviceHash: hashDeviceToken(token),
    label,
    trustedUntil: expiresAt,
    lastSeenAt: new Date(),
  });

  return { token, expiresAt };
}

/** Returns the row only if the token is this user's and still inside its window. */
export async function findTrustedDevice(
  db: MasterDatabase,
  userId: string,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<InfraTrustedDeviceRow | null> {
  if (token === null || token === undefined || token === '') return null;

  const [row] = await db
    .select()
    .from(infraTrustedDevices)
    .where(
      and(
        eq(infraTrustedDevices.userId, userId),
        eq(infraTrustedDevices.deviceHash, hashDeviceToken(token)),
        gt(infraTrustedDevices.trustedUntil, now),
      ),
    )
    .limit(1);

  if (row === undefined) return null;

  void db
    .update(infraTrustedDevices)
    .set({ lastSeenAt: now })
    .where(eq(infraTrustedDevices.id, row.id))
    .catch(() => {});

  return row;
}

export async function listTrustedDevices(
  db: MasterDatabase,
  userId: string,
): Promise<InfraTrustedDeviceRow[]> {
  return db.select().from(infraTrustedDevices).where(eq(infraTrustedDevices.userId, userId));
}

export async function revokeTrustedDevice(db: MasterDatabase, id: string, userId: string): Promise<void> {
  await db
    .delete(infraTrustedDevices)
    .where(and(eq(infraTrustedDevices.id, id), eq(infraTrustedDevices.userId, userId)));
}

export async function revokeAllTrustedDevices(db: MasterDatabase, userId: string): Promise<number> {
  const removed = await db
    .delete(infraTrustedDevices)
    .where(eq(infraTrustedDevices.userId, userId))
    .returning({ id: infraTrustedDevices.id });
  return removed.length;
}
