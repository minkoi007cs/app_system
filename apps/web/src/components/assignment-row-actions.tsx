'use client';

import { useTransition } from 'react';
import { revokeAssignmentAction } from '@/actions/access';
import { Button } from '@/components/ui/button';

export function AssignmentRowActions({ appId, assignmentId }: { appId: string; assignmentId: string }) {
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        start(async () => {
          await revokeAssignmentAction(appId, assignmentId);
        });
      }}
    >
      {pending ? 'Revoking…' : 'Revoke'}
    </Button>
  );
}
