'use client';

import { useTransition } from 'react';
import { stopImpersonation } from '@/actions/impersonation';
import { Button } from '@/components/ui/button';

export function StopImpersonationButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await stopImpersonation();
        });
      }}
    >
      {pending ? 'Ending…' : 'End impersonation'}
    </Button>
  );
}
