'use client';

import { useTransition } from 'react';
import { deletePolicyAction, togglePolicyAction } from '@/actions/access';
import { Button } from '@/components/ui/button';

export function PolicyRowActions({
  appId,
  policyId,
  enabled,
}: {
  appId: string;
  policyId: string;
  enabled: boolean;
}) {
  const [pending, start] = useTransition();

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          start(async () => {
            await togglePolicyAction(appId, policyId, !enabled);
          });
        }}
      >
        {enabled ? 'Disable' : 'Enable'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          start(async () => {
            await deletePolicyAction(appId, policyId);
          });
        }}
      >
        Delete
      </Button>
    </div>
  );
}
