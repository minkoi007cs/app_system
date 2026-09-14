'use client';

import { useActionState } from 'react';
import { createRoleAction, type AccessState } from '@/actions/access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: AccessState = { ok: false, message: '' };

export function CreateRoleForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(createRoleAction, INITIAL);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border p-4">
      <input type="hidden" name="appId" value={appId} />

      <div className="grid gap-1.5">
        <Label htmlFor="key">Key</Label>
        <Input id="key" name="key" placeholder="editor" required className="w-36" />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" placeholder="Content editor" className="w-48" />
      </div>

      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="permissions">Permissions</Label>
        <Input
          id="permissions"
          name="permissions"
          placeholder="notes:read notes:write"
          required
          className="font-mono text-xs"
        />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Add role'}
      </Button>

      <p className="text-muted-foreground w-full text-xs">
        Space-separated <code>resource:verb</code> pairs. A <code>*</code> matches a whole segment —
        <code> notes:*</code> covers every verb on notes, but <code>note*:read</code> matches
        nothing, because wildcards are whole-segment only.
      </p>

      {state.message === '' ? null : (
        <p className={state.ok ? 'w-full text-sm' : 'text-destructive w-full text-sm'}>{state.message}</p>
      )}
    </form>
  );
}
