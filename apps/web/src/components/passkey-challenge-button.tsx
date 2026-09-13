'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import {
  finishPasskeyAuthenticationAction,
  startPasskeyAuthenticationAction,
} from '@/actions/passkey';
import { Button } from '@/components/ui/button';

export function PasskeyChallengeButton({ rememberDevice }: { rememberDevice: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const started = await startPasskeyAuthenticationAction();
      if (!started.ok || started.options === undefined) {
        setError(started.message);
        return;
      }
      const response = await startAuthentication({
        optionsJSON: started.options as PublicKeyCredentialRequestOptionsJSON,
      });
      const finished = await finishPasskeyAuthenticationAction(response, rememberDevice);
      if (!finished.ok) {
        setError(finished.message);
        return;
      }
      router.push('/apps');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error && cause.name === 'NotAllowedError' ? null : 'passkey check failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={verify}>
        {pending ? 'Waiting for your device…' : 'Use a passkey instead'}
      </Button>
      {error !== null ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}
