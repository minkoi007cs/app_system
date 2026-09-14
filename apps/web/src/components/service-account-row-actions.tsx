'use client';

import { useActionState, useTransition } from 'react';
import { issueServiceKeyAction, revokeServiceAccountAction, type MachineState } from '@/actions/machines';
import { Button } from '@/components/ui/button';
import { RevealOnce } from '@/components/reveal-once';

const INITIAL: MachineState = { ok: false, message: '' };

export function ServiceAccountRowActions({
  appId,
  accountId,
  active,
}: {
  appId: string;
  accountId: string;
  active: boolean;
}) {
  const [state, issue, issuing] = useActionState(issueServiceKeyAction, INITIAL);
  const [revoking, startRevoke] = useTransition();

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex gap-2">
        <form action={issue}>
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="serviceAccountId" value={accountId} />
          <Button size="sm" variant="outline" type="submit" disabled={issuing || !active}>
            {issuing ? 'Issuing…' : 'Issue key'}
          </Button>
        </form>

        <Button
          size="sm"
          variant="ghost"
          disabled={revoking || !active}
          onClick={() => {
            startRevoke(async () => {
              await revokeServiceAccountAction(appId, accountId);
            });
          }}
        >
          Revoke
        </Button>
      </div>

      {state.rawKey === undefined ? null : (
        <RevealOnce rawKey={state.rawKey} note={state.message} />
      )}
    </div>
  );
}
