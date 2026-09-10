'use client';

import { useState, useTransition } from 'react';
import { revokeKeyAction, rotateKeyAction } from '@/actions/keys';
import { Button } from '@/components/ui/button';
import { RevealOnce } from '@/components/reveal-once';

export function KeyRowActions({ appId, keyId }: { appId: string; keyId: string }) {
  const [pending, startTransition] = useTransition();
  const [rotated, setRotated] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await rotateKeyAction(appId, keyId);
              setRotated(result.rawKey ?? null);
            });
          }}
        >
          Rotate
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              await revokeKeyAction(appId, keyId);
            });
          }}
        >
          Revoke
        </Button>
      </div>
      {rotated !== null ? <RevealOnce rawKey={rotated} note="new key — copy it now" /> : null}
    </div>
  );
}
