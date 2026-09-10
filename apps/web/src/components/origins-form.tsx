'use client';

import { useActionState } from 'react';
import { updateOriginsAction, type ActionState } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const INITIAL: ActionState = { ok: false, message: '' };

export function OriginsForm({ appId, origins }: { appId: string; origins: string[] }) {
  const [state, action, pending] = useActionState(updateOriginsAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="appId" value={appId} />
      <div className="flex gap-2">
        <Input
          name="origins"
          defaultValue={origins.join(' ')}
          placeholder="https://app.example.com https://localhost:3001"
        />
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Space or comma separated. Only these origins may call the auth endpoints for this app.
      </p>
      {state.message !== '' ? (
        <p className={`text-sm ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`}>{state.message}</p>
      ) : null}
    </form>
  );
}
