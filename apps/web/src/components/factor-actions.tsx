'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { forgetAllDevicesAction, removeFactorAction } from '@/actions/passkey';
import { Button } from '@/components/ui/button';

interface Props {
  factorId?: string;
  canRemove?: boolean;
  forgetDevices?: boolean;
}

export function FactorActions({ factorId, canRemove = false, forgetDevices = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  if (forgetDevices) {
    return (
      <div className="flex items-center gap-2">
        {note !== null ? <span className="text-muted-foreground text-xs">{note}</span> : null}
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await forgetAllDevicesAction();
              setNote(result.message);
              router.refresh();
            });
          }}
        >
          Forget all
        </Button>
      </div>
    );
  }

  if (factorId === undefined || !canRemove) {
    return <span className="text-muted-foreground text-xs">last factor</span>;
  }

  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await removeFactorAction(factorId);
          router.refresh();
        });
      }}
    >
      Remove
    </Button>
  );
}
