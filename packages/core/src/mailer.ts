/**
 * Sending mail, and the reason this is an interface rather than a Resend call.
 *
 * Exactly one thing on this platform needs email today: the password recovery link. That makes it
 * tempting to inline an HTTP call to whichever provider is at hand. The reason not to is not
 * abstraction for its own sake — it is that the recovery flow is the one place where a delivery
 * failure is **indistinguishable from an attack** to the person on the other end. They asked to
 * reset their password and nothing arrived; they cannot tell whether the mail is slow, whether
 * their address is wrong, or whether somebody has taken their account. So the transport has to be
 * swappable, testable without a network, and loud when it fails.
 *
 * Three transports ship here:
 *
 *   `console`  — development. Prints the link so the flow can be walked end to end.
 *   `resend`   — one HTTPS call, no SDK, so there is no dependency to keep current.
 *   `webhook`  — POSTs the message to a URL the deployment owns, for SMTP relays and anything else.
 *
 * `none` is not a transport. A deployment with no mail configured gets an error at send time and a
 * loud log line, never a silent success — because a recovery flow that reports success and sends
 * nothing is worse than one that is visibly broken.
 */
import { InfraError } from './errors.js';
import type { FetchLike } from './password.js';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Every message this platform sends is a link and a sentence; HTML earns nothing. */
  text: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}

// FetchLike is shared with the HIBP lookup in password.ts — one definition, so a caller cannot
// pass a fetch that satisfies one and not the other.

export interface MailConfig {
  provider?: string | undefined;
  apiKey?: string | undefined;
  from?: string | undefined;
  webhookUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number;
}

export const MAIL_TIMEOUT_MS = 10_000;

/** Redacts the local part: enough to correlate a log line, not enough to harvest addresses. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (domain === undefined || local === undefined || local === '') return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  config: MailConfig,
): Promise<void> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new InfraError('CONFIG_INVALID', 'no fetch implementation available for mail delivery');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs ?? MAIL_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Status only. A provider's error body can quote the message it was given, recipient included.
      throw new InfraError('INTERNAL', 'mail provider rejected the message', {
        details: { status: response.status },
      });
    }
  } catch (cause) {
    if (InfraError.is(cause)) throw cause;
    const timedOut = cause instanceof Error && cause.name === 'AbortError';
    throw new InfraError('INTERNAL', timedOut ? 'mail provider timed out' : 'could not reach the mail provider', {
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function consoleTransport(): MailTransport {
  return {
    name: 'console',
    async send(message) {
      console.info(`[mail:console] to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}

export function resendTransport(config: MailConfig): MailTransport {
  const apiKey = config.apiKey ?? '';
  const from = config.from ?? '';

  return {
    name: 'resend',
    async send(message) {
      if (apiKey === '' || from === '') {
        throw new InfraError('CONFIG_INVALID', 'resend needs INFRA_MAIL_API_KEY and INFRA_MAIL_FROM');
      }
      await postJson(
        'https://api.resend.com/emails',
        { from, to: [message.to], subject: message.subject, text: message.text },
        { authorization: `Bearer ${apiKey}` },
        config,
      );
    },
  };
}

export function webhookTransport(config: MailConfig): MailTransport {
  const url = config.webhookUrl ?? '';

  return {
    name: 'webhook',
    async send(message) {
      if (url === '') {
        throw new InfraError('CONFIG_INVALID', 'webhook mail needs INFRA_MAIL_WEBHOOK_URL');
      }
      await postJson(
        url,
        { from: config.from ?? null, to: message.to, subject: message.subject, text: message.text },
        config.apiKey === undefined || config.apiKey === ''
          ? {}
          : { authorization: `Bearer ${config.apiKey}` },
        config,
      );
    },
  };
}

/**
 * Refuses rather than silently discarding.
 *
 * This is what an unconfigured deployment gets, and it exists so that "no mailer" is a visible
 * state rather than a quiet one.
 */
export function unconfiguredTransport(): MailTransport {
  return {
    name: 'unconfigured',
    async send(message) {
      console.error(
        `[mail] no transport configured — a message to ${maskEmail(message.to)} was NOT sent. ` +
          `Set INFRA_MAIL_PROVIDER (console | resend | webhook).`,
      );
      throw new InfraError('CONFIG_INVALID', 'no mail transport is configured');
    },
  };
}

export function createMailTransport(config: MailConfig = {}): MailTransport {
  switch ((config.provider ?? '').toLowerCase()) {
    case 'console':
      return consoleTransport();
    case 'resend':
      return resendTransport(config);
    case 'webhook':
      return webhookTransport(config);
    default:
      return unconfiguredTransport();
  }
}

export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
  return {
    provider: env['INFRA_MAIL_PROVIDER'],
    apiKey: env['INFRA_MAIL_API_KEY'],
    from: env['INFRA_MAIL_FROM'],
    webhookUrl: env['INFRA_MAIL_WEBHOOK_URL'],
  };
}
