/**
 * Webhook endpoints and the delivery queue.
 *
 * Enqueue and dispatch are separate on purpose. An identity event — someone was suspended, a
 * password was reset — must be recorded whether or not the tenant's server happens to be up, and
 * the request that caused it must not wait on a third party's socket. So the emitting path writes
 * rows and returns; a drain pass sends them.
 */
import { and, asc, eq, inArray, lte, or, isNull, sql } from 'drizzle-orm';
import {
  buildEvent,
  decryptSecret,
  encryptSecret,
  generateWebhookSecret,
  InfraError,
  isPublicHttpUrl,
  nextAttemptAt,
  type WebhookEvent,
  type WebhookEventType,
} from '@infra/core';
import type { MasterDatabase } from '../client.js';
import { infraAppMembers } from '../schema/auth.js';
import {
  infraWebhookDeliveries,
  infraWebhookEndpoints,
  type InfraWebhookDeliveryRow,
  type InfraWebhookEndpointRow,
} from '../schema/webhooks.js';

/** Binds a ciphertext to its row: a secret lifted from one endpoint will not decrypt on another. */
export function webhookAad(endpointId: string): string {
  return `webhook:${endpointId}`;
}

export interface CreateEndpointInput {
  appId: string;
  url: string;
  description?: string | null;
  eventTypes?: readonly WebhookEventType[];
}

export interface CreatedEndpoint {
  row: InfraWebhookEndpointRow;
  /** Shown once. The tenant needs it to verify signatures; we keep only the envelope. */
  secret: string;
}

export async function createWebhookEndpoint(
  db: MasterDatabase,
  input: CreateEndpointInput,
): Promise<CreatedEndpoint> {
  const verdict = isPublicHttpUrl(input.url);
  if (!verdict.ok) {
    throw new InfraError('VALIDATION_FAILED', verdict.reason ?? 'url not accepted', {
      details: { url: input.url },
    });
  }

  const id = crypto.randomUUID();
  const secret = generateWebhookSecret();
  const envelope = encryptSecret(secret, webhookAad(id));

  const [row] = await db
    .insert(infraWebhookEndpoints)
    .values({
      id,
      appId: input.appId,
      url: input.url,
      description: input.description ?? null,
      eventTypes: [...(input.eventTypes ?? [])],
      encryptedSecret: envelope.ciphertext,
      encryptionIv: envelope.iv,
      encryptionAuthTag: envelope.authTag,
      encryptionKeyVersion: envelope.keyVersion,
    })
    .returning();

  if (row === undefined) throw new InfraError('INTERNAL', 'webhook endpoint insert returned no row');
  return { row, secret };
}

export function revealWebhookSecret(row: InfraWebhookEndpointRow): string {
  return decryptSecret(
    {
      ciphertext: row.encryptedSecret,
      iv: row.encryptionIv,
      authTag: row.encryptionAuthTag,
      keyVersion: row.encryptionKeyVersion,
    },
    webhookAad(row.id),
  );
}

export async function rotateWebhookSecret(db: MasterDatabase, endpointId: string): Promise<string> {
  const secret = generateWebhookSecret();
  const envelope = encryptSecret(secret, webhookAad(endpointId));

  await db
    .update(infraWebhookEndpoints)
    .set({
      encryptedSecret: envelope.ciphertext,
      encryptionIv: envelope.iv,
      encryptionAuthTag: envelope.authTag,
      encryptionKeyVersion: envelope.keyVersion,
      updatedAt: new Date(),
    })
    .where(eq(infraWebhookEndpoints.id, endpointId));

  return secret;
}

export async function listWebhookEndpoints(
  db: MasterDatabase,
  appId: string,
): Promise<InfraWebhookEndpointRow[]> {
  return db.select().from(infraWebhookEndpoints).where(eq(infraWebhookEndpoints.appId, appId));
}

export async function setWebhookEndpointStatus(
  db: MasterDatabase,
  endpointId: string,
  status: 'active' | 'paused' | 'disabled',
): Promise<void> {
  await db
    .update(infraWebhookEndpoints)
    .set({
      status,
      disabledAt: status === 'disabled' ? new Date() : null,
      consecutiveFailures: status === 'active' ? 0 : undefined,
      updatedAt: new Date(),
    })
    .where(eq(infraWebhookEndpoints.id, endpointId));
}

// ── emitting ─────────────────────────────────────────────────────────────────

/** An endpoint with an empty subscription list hears everything. */
function subscribes(row: InfraWebhookEndpointRow, type: WebhookEventType): boolean {
  return row.eventTypes.length === 0 || row.eventTypes.includes(type);
}

export interface EmitResult {
  event: WebhookEvent;
  queued: number;
}

/**
 * Fans one event out to every active endpoint that subscribes to it.
 *
 * Returns rather than throws when nothing is listening: an app with no webhooks configured is the
 * normal case, and an identity operation must not fail because of it.
 */
export async function emitWebhookEvent(
  db: MasterDatabase,
  appId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<EmitResult> {
  const event = buildEvent(type, appId, data, now);

  const endpoints = await db
    .select()
    .from(infraWebhookEndpoints)
    .where(and(eq(infraWebhookEndpoints.appId, appId), eq(infraWebhookEndpoints.status, 'active')));

  const targets = endpoints.filter((row) => subscribes(row, type));
  if (targets.length === 0) return { event, queued: 0 };

  await db.insert(infraWebhookDeliveries).values(
    targets.map((endpoint) => ({
      endpointId: endpoint.id,
      appId,
      eventId: event.id,
      eventType: type,
      payload: event as unknown as Record<string, unknown>,
      nextAttemptAt: now,
    })),
  );

  return { event, queued: targets.length };
}

/**
 * Lifecycle events are global — a person is suspended once, not once per app — but webhooks are
 * per-app, so one lifecycle change fans out to every app the person belongs to. An app hears only
 * about its own members, which is the same isolation rule the rest of the platform follows.
 */
export async function emitToUserApps(
  db: MasterDatabase,
  userId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  now: Date = new Date(),
): Promise<number> {
  const memberships = await db
    .select({ appId: infraAppMembers.appId })
    .from(infraAppMembers)
    .where(eq(infraAppMembers.userId, userId));

  let queued = 0;
  for (const membership of memberships) {
    const result = await emitWebhookEvent(db, membership.appId, type, data, now);
    queued += result.queued;
  }
  return queued;
}

export function emitToUserAppsAsync(
  db: MasterDatabase,
  userId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
): void {
  void emitToUserApps(db, userId, type, data).catch(() => {
    /* webhook emission is best-effort */
  });
}

/** Best-effort variant for request paths: emitting must never fail the operation that caused it. */
export function emitWebhookEventAsync(
  db: MasterDatabase,
  appId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
): void {
  void emitWebhookEvent(db, appId, type, data).catch(() => {
    /* webhook emission is best-effort */
  });
}

// ── draining ─────────────────────────────────────────────────────────────────

export interface DueDelivery {
  delivery: InfraWebhookDeliveryRow;
  endpoint: InfraWebhookEndpointRow;
}

export async function claimDueDeliveries(
  db: MasterDatabase,
  limit = 25,
  now: Date = new Date(),
): Promise<DueDelivery[]> {
  const rows = await db
    .select({ delivery: infraWebhookDeliveries, endpoint: infraWebhookEndpoints })
    .from(infraWebhookDeliveries)
    .innerJoin(infraWebhookEndpoints, eq(infraWebhookDeliveries.endpointId, infraWebhookEndpoints.id))
    .where(
      and(
        eq(infraWebhookDeliveries.status, 'pending'),
        eq(infraWebhookEndpoints.status, 'active'),
        or(isNull(infraWebhookDeliveries.nextAttemptAt), lte(infraWebhookDeliveries.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(infraWebhookDeliveries.createdAt))
    .limit(limit);

  return rows;
}

export async function markDelivered(
  db: MasterDatabase,
  deliveryId: string,
  endpointId: string,
  statusCode: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(infraWebhookDeliveries)
    .set({
      status: 'delivered',
      attempts: sql`${infraWebhookDeliveries.attempts} + 1`,
      lastStatusCode: statusCode,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: now,
    })
    .where(eq(infraWebhookDeliveries.id, deliveryId));

  await db
    .update(infraWebhookEndpoints)
    .set({ consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now })
    .where(eq(infraWebhookEndpoints.id, endpointId));
}

/** Consecutive failures at which an endpoint is switched off rather than retried forever. */
export const BREAKER_THRESHOLD = 20;

export async function markAttemptFailed(
  db: MasterDatabase,
  delivery: InfraWebhookDeliveryRow,
  statusCode: number | null,
  reason: string,
  retryable: boolean,
  now: Date = new Date(),
): Promise<void> {
  const attempts = delivery.attempts + 1;
  const next = retryable ? nextAttemptAt(attempts, now) : null;

  await db
    .update(infraWebhookDeliveries)
    .set({
      // A non-retryable answer is the receiver saying "never send this again" — dropped, not failed.
      status: next !== null ? 'pending' : retryable ? 'failed' : 'dropped',
      attempts,
      lastStatusCode: statusCode,
      lastError: reason.slice(0, 255),
      nextAttemptAt: next,
    })
    .where(eq(infraWebhookDeliveries.id, delivery.id));

  const [endpoint] = await db
    .update(infraWebhookEndpoints)
    .set({
      consecutiveFailures: sql`${infraWebhookEndpoints.consecutiveFailures} + 1`,
      updatedAt: now,
    })
    .where(eq(infraWebhookEndpoints.id, delivery.endpointId))
    .returning();

  if (endpoint !== undefined && endpoint.consecutiveFailures >= BREAKER_THRESHOLD) {
    await db
      .update(infraWebhookEndpoints)
      .set({ status: 'disabled', disabledAt: now, updatedAt: now })
      .where(eq(infraWebhookEndpoints.id, endpoint.id));
  }
}

export async function listDeliveries(
  db: MasterDatabase,
  endpointId: string,
  limit = 50,
): Promise<InfraWebhookDeliveryRow[]> {
  return db
    .select()
    .from(infraWebhookDeliveries)
    .where(eq(infraWebhookDeliveries.endpointId, endpointId))
    .orderBy(asc(infraWebhookDeliveries.createdAt))
    .limit(limit);
}

export async function purgeSettledDeliveries(db: MasterDatabase, before: Date): Promise<number> {
  const removed = await db
    .delete(infraWebhookDeliveries)
    .where(
      and(
        inArray(infraWebhookDeliveries.status, ['delivered', 'dropped']),
        lte(infraWebhookDeliveries.createdAt, before),
      ),
    )
    .returning({ id: infraWebhookDeliveries.id });
  return removed.length;
}
