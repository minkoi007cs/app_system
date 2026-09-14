'use client';

import { useActionState } from 'react';
import { createWorkspaceAction, type MachineState } from '@/actions/machines';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: MachineState = { ok: false, message: '' };

export function WorkspaceForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(createWorkspaceAction, INITIAL);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border p-4">
      <input type="hidden" name="appId" value={appId} />

      <div className="grid gap-1.5">
        <Label htmlFor="ws-slug">Slug</Label>
        <Input id="ws-slug" name="slug" placeholder="acme" required className="w-36" />
      </div>

      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="ws-name">Name</Label>
        <Input id="ws-name" name="name" placeholder="Acme Corp" required />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Add workspace'}
      </Button>

      {state.message === '' ? null : (
        <p className={state.ok ? 'w-full text-sm' : 'text-destructive w-full text-sm'}>{state.message}</p>
      )}
    </form>
  );
}
