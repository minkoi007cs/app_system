import { describe, expect, it, vi } from 'vitest';
import { InfraError } from '../src/errors.js';
import {
  createMailTransport,
  maskEmail,
  resendTransport,
  unconfiguredTransport,
  webhookTransport,
  type MailMessage,
} from '../src/mailer.js';

const message: MailMessage = {
  to: 'alice@example.com',
  subject: 'Reset your password',
  text: 'https://infra.test/recover?token=rec_abc',
};

function recorder(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { impl, calls };
}

describe('transport selection', () => {
  it('falls back to a transport that refuses, not one that discards', async () => {
    // The default matters more than the configured cases: a deployment that forgot to set a
    // provider must find out at send time, loudly.
    const transport = createMailTransport({});
    expect(transport.name).toBe('unconfigured');
    await expect(transport.send(message)).rejects.toBeInstanceOf(InfraError);
  });

  it('does not treat an unknown provider name as a working transport', async () => {
    const transport = createMailTransport({ provider: 'mailgun' });
    expect(transport.name).toBe('unconfigured');
    await expect(transport.send(message)).rejects.toBeInstanceOf(InfraError);
  });

  it('selects each shipped transport by name, case-insensitively', () => {
    expect(createMailTransport({ provider: 'console' }).name).toBe('console');
    expect(createMailTransport({ provider: 'RESEND' }).name).toBe('resend');
    expect(createMailTransport({ provider: 'Webhook' }).name).toBe('webhook');
  });

  it('logs the address masked when it refuses', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await unconfiguredTransport().send(message).catch(() => {});
      const logged = String(spy.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain('al***@example.com');
      expect(logged).not.toContain('alice@example.com');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resend transport', () => {
  it('posts the message with the api key as a bearer token', async () => {
    const { impl, calls } = recorder();
    await resendTransport({ apiKey: 're_key', from: 'noreply@infra.test', fetchImpl: impl }).send(message);

    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer re_key');
    expect(calls[0]?.body).toEqual({
      from: 'noreply@infra.test',
      to: ['alice@example.com'],
      subject: message.subject,
      text: message.text,
    });
  });

  it('refuses before the network when it is half-configured', async () => {
    const { impl, calls } = recorder();
    await expect(
      resendTransport({ apiKey: 're_key', fetchImpl: impl }).send(message),
    ).rejects.toThrowError(/INFRA_MAIL_FROM/);
    expect(calls).toHaveLength(0);
  });

  it('never puts the provider response body into the error', async () => {
    // A provider echoing the message back would put the recipient into an error we might log.
    const { impl } = recorder(422, { message: 'invalid recipient alice@example.com' });
    try {
      await resendTransport({ apiKey: 'k', from: 'f@x.test', fetchImpl: impl }).send(message);
      expect.unreachable('should have thrown');
    } catch (error) {
      const serialised = JSON.stringify(InfraError.is(error) ? error.toJSON() : {});
      expect(serialised).not.toContain('alice@example.com');
      expect(serialised).toContain('422');
    }
  });

  it('turns a hanging provider into an error rather than a stuck request', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as never;

    await expect(
      resendTransport({ apiKey: 'k', from: 'f@x.test', fetchImpl: hanging, timeoutMs: 5 }).send(message),
    ).rejects.toThrowError(/timed out/);
  });
});

describe('webhook transport', () => {
  it('posts to the configured url', async () => {
    const { impl, calls } = recorder();
    await webhookTransport({ webhookUrl: 'https://relay.test/send', fetchImpl: impl }).send(message);

    expect(calls[0]?.url).toBe('https://relay.test/send');
    expect(calls[0]?.body).toMatchObject({ to: 'alice@example.com', subject: message.subject });
  });

  it('omits the authorization header when no key is set', async () => {
    const { impl, calls } = recorder();
    await webhookTransport({ webhookUrl: 'https://relay.test/send', fetchImpl: impl }).send(message);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('refuses without a url', async () => {
    await expect(webhookTransport({}).send(message)).rejects.toThrowError(/WEBHOOK_URL/);
  });
});

describe('maskEmail', () => {
  it('keeps enough to correlate and not enough to harvest', () => {
    expect(maskEmail('alice@example.com')).toBe('al***@example.com');
    expect(maskEmail('bo@example.com')).toBe('bo***@example.com');
  });

  it('degrades safely on junk rather than echoing it', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});
