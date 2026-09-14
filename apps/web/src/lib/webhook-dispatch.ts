/**
 * The sender half of the webhook system.
 *
 * Everything dangerous about outbound webhooks is concentrated here, so it can be reviewed in one
 * place:
 *
 *   - the URL is re-checked immediately before the request, not only when it was registered, in
 *     case the row was edited by a path that skipped validation;
 *   - redirects are refused (`redirect: 'manual'`), because a public host that 302s to
 *     169.254.169.254 defeats a URL-only SSRF check;
 *   - there is a hard timeout, so one unresponsive tenant cannot hold a worker open;
 *   - the response body is never read past its status code — it is attacker-controlled text we have
 *     no use for, and reading it is how a slow-loris response becomes our problem.
 */
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  shouldRetry,
  signWebhook,
  isPublicHttpUrl,
} from '@infra/core';
import {
  claimDueDeliveries,
  markAttemptFailed,
  markDelivered,
  revealWebhookSecret,
  type DueDelivery,
} from '@infra/db';
import { db } from './db';

export const DELIVERY_TIMEOUT_MS = 8_000;

export interface DispatchOutcome {
  deliveryId: string;
  ok: boolean;
  statusCode: number | null;
  reason: string;
}

export async function dispatchOne(due: DueDelivery): Promise<DispatchOutcome> {
  const { delivery, endpoint } = due;

  const verdict = isPublicHttpUrl(endpoint.url);
  if (!verdict.ok) {
    await markAttemptFailed(db(), delivery, null, verdict.reason ?? 'url rejected', false);
    return { deliveryId: delivery.id, ok: false, statusCode: null, reason: 'url rejected' };
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  let secret: string;
  try {
    secret = revealWebhookSecret(endpoint);
  } catch {
    // Undecryptable secret means the master key changed under us: retrying cannot help.
    await markAttemptFailed(db(), delivery, null, 'signing secret unavailable', false);
    return { deliveryId: delivery.id, ok: false, statusCode: null, reason: 'signing secret unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signWebhook(secret, body, timestamp),
        [EVENT_ID_HEADER]: delivery.eventId,
        'user-agent': 'unified-app-infra-webhooks/1',
      },
      body,
    });

    if (response.status >= 200 && response.status < 300) {
      await markDelivered(db(), delivery.id, endpoint.id, response.status);
      return { deliveryId: delivery.id, ok: true, statusCode: response.status, reason: 'delivered' };
    }

    // A manual-redirect response arrives with status 0 / type 'opaqueredirect'.
    const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    const reason = redirected ? 'redirect refused' : `http ${response.status}`;

    await markAttemptFailed(db(), delivery, response.status, reason, !redirected && shouldRetry(response.status));
    return { deliveryId: delivery.id, ok: false, statusCode: response.status, reason };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network error';
    await markAttemptFailed(db(), delivery, null, reason, true);
    return { deliveryId: delivery.id, ok: false, statusCode: null, reason };
  } finally {
    clearTimeout(timer);
  }
}

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
}

/** One pass over whatever is due. Deliveries run in parallel; one slow tenant cannot block another. */
export async function drainWebhookQueue(limit = 25): Promise<DrainResult> {
  const due = await claimDueDeliveries(db(), limit);
  if (due.length === 0) return { attempted: 0, delivered: 0, failed: 0 };

  const outcomes = await Promise.all(due.map((item) => dispatchOne(item)));
  const delivered = outcomes.filter((outcome) => outcome.ok).length;

  return { attempted: outcomes.length, delivered, failed: outcomes.length - delivered };
}
