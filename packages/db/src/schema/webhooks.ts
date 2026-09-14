/**
 * Webhook endpoints and their delivery queue.
 *
 * The signing secret is stored the same way tenant connection strings are: an AES-256-GCM envelope
 * with an AAD bound to the row, so a ciphertext lifted from one endpoint cannot be pasted into
 * another. The delivery queue is a table rather than an in-process timer on purpose — a retry
 * schedule that lives in memory is a retry schedule that a deploy silently cancels.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { WebhookEventType } from '@infra/core';
import { infraApps } from './apps.js';

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'paused', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

export const infraWebhookEndpoints = pgTable(
  'infra_webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: varchar('description', { length: 255 }),
    /** Empty means every event type — explicit subscription is the default the dashboard writes. */
    eventTypes: jsonb('event_types').$type<WebhookEventType[]>().notNull().default([]),
    status: varchar('status', { length: 16 }).notNull().default('active').$type<WebhookEndpointStatus>(),

    // ── AES-256-GCM envelope over the whsec_ signing secret ──────────────────
    encryptedSecret: text('encrypted_secret').notNull(),
    encryptionIv: varchar('encryption_iv', { length: 24 }).notNull(),
    encryptionAuthTag: varchar('encryption_auth_tag', { length: 32 }).notNull(),
    encryptionKeyVersion: integer('encryption_key_version').notNull().default(1),

    /** Set when consecutive failures trip the breaker, so a dead endpoint stops costing anything. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('infra_webhook_endpoints_app_idx').on(t.appId, t.status)],
);

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dropped'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const infraWebhookDeliveries = pgTable(
  'infra_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => infraWebhookEndpoints.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => infraApps.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 48 }).notNull().$type<WebhookEventType>(),
    /** The exact JSON that gets signed and sent. Carries ids and timestamps, never a secret. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending').$type<DeliveryStatus>(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastStatusCode: integer('last_status_code'),
    /** Reason only — a status line or an error name, never a response body. */
    lastError: varchar('last_error', { length: 255 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('infra_webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('infra_webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),
  ],
);

export type InfraWebhookEndpointRow = typeof infraWebhookEndpoints.$inferSelect;
export type InfraWebhookDeliveryRow = typeof infraWebhookDeliveries.$inferSelect;
