'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { finishPasskeyRegistrationAction, startPasskeyRegistrationAction } from '@/actions/passkey';
import { Button } from '@/components/ui/button';

export function AddPasskeyButton({ label = 'Add passkey' }: { label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enrol(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const started = await startPasskeyRegistrationAction();
      if (!started.ok || started.options === undefined) {
        setError(started.message);
        return;
      }

      const response = await startRegistration({
        optionsJSON: started.options as PublicKeyCredentialCreationOptionsJSON,
      });
      const finished = await finishPasskeyRegistrationAction(response, deviceLabel());
      if (!finished.ok) {
        setError(finished.message);
        return;
      }
      router.refresh();
    } catch (cause) {
      // A user who cancels the browser prompt is not an error worth shouting about.
      setError(cause instanceof Error && cause.name === 'NotAllowedError' ? null : 'passkey setup failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error !== null ? <span className="text-destructive text-xs">{error}</span> : null}
      <Button size="sm" variant="outline" disabled={pending} onClick={enrol}>
        {pending ? 'Waiting for your device…' : label}
      </Button>
    </div>
  );
}

function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Passkey';
  const agent = navigator.userAgent;
  if (agent.includes('Mac')) return 'Passkey on Mac';
  if (agent.includes('iPhone') || agent.includes('iPad')) return 'Passkey on iPhone/iPad';
  if (agent.includes('Windows')) return 'Passkey on Windows';
  if (agent.includes('Android')) return 'Passkey on Android';
  return 'Passkey';
}
