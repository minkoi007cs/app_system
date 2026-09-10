'use client';

import { useTransition } from 'react';
import { setAppStatusAction } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import type { AppStatus } from '@infra/db';

const OPTIONS: Array<{ status: AppStatus; label: string; variant: 'default' | 'secondary' | 'destructive' }> = [
  { status: 'active', label: 'Activate', variant: 'default' },
  { status: 'suspended', label: 'Suspend', variant: 'secondary' },
  { status: 'archived', label: 'Archive', variant: 'destructive' },
];

export function StatusButtons({ appId, status }: { appId: string; status: AppStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-wrap gap-2">
      {OPTIONS.map((option) => (
        <Button
          key={option.status}
          variant={option.variant}
          disabled={pending || status === option.status}
          onClick={() => {
            startTransition(async () => {
              await setAppStatusAction(appId, option.status);
            });
          }}
        >
          {option.label}
        </Button>
      ))}
      <p className="text-muted-foreground w-full text-xs">
        Suspending an app makes every one of its API keys stop working immediately.
      </p>
    </div>
  );
}
