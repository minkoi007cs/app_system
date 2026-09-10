'use client';

import { useState, useTransition } from 'react';
import { checkHealthAction } from '@/actions/database';
import { Button } from '@/components/ui/button';

export function HealthButton({ appId }: { appId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {result !== null ? <span className="text-muted-foreground text-xs">{result}</span> : null}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const report = await checkHealthAction(appId);
            setResult(report.message);
          });
        }}
      >
        {pending ? 'Checking…' : 'Check health'}
      </Button>
    </div>
  );
}
