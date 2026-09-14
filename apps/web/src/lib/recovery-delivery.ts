/**
 * Where a recovery link goes.
 *
 * The one rule that outlives whichever transport is configured: **the raw token is never returned
 * to the caller of the HTTP endpoint.** If it were, "forgot password" would become "reset anyone's
 * password" for whoever can reach the API.
 *
 * Delivery is awaited rather than fired and forgotten. The endpoint answers 202 either way — it
 * must not reveal whether the address exists — but the platform needs to know in its own logs
 * whether the mail actually went, because "the user says nothing arrived" is otherwise
 * unanswerable.
 */
import { createMailTransport, mailConfigFromEnv, maskEmail, type MailTransport } from '@infra/core';

export interface RecoveryLink {
  email: string;
  url: string;
}

interface TransportGlobal {
  __infraMailTransport?: MailTransport;
}

const transportGlobal = globalThis as unknown as TransportGlobal;

function transport(): MailTransport {
  transportGlobal.__infraMailTransport ??= createMailTransport(mailConfigFromEnv());
  return transportGlobal.__infraMailTransport;
}

export function recoveryUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/recover?token=${encodeURIComponent(token)}`;
}

const SUBJECT = 'Reset your password';

function body(url: string): string {
  return [
    'Somebody asked to reset the password for this account.',
    '',
    url,
    '',
    'The link works once and expires in 15 minutes.',
    'If this was not you, no action is needed — the link cannot be used without this email.',
  ].join('\n');
}

export interface DeliveryOutcome {
  delivered: boolean;
  transport: string;
}

export async function deliverRecoveryLink(link: RecoveryLink): Promise<DeliveryOutcome> {
  const mailer = transport();

  try {
    await mailer.send({ to: link.email, subject: SUBJECT, text: body(link.url) });
    // Masked: the log records that a link went out, not a harvestable address.
    console.info(`[recovery] link sent to ${maskEmail(link.email)} via ${mailer.name}`);
    return { delivered: true, transport: mailer.name };
  } catch (error) {
    console.error(
      `[recovery] could not send to ${maskEmail(link.email)} via ${mailer.name}:`,
      error instanceof Error ? error.message : 'unknown error',
    );
    return { delivered: false, transport: mailer.name };
  }
}
