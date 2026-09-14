'use client';

import { useActionState } from 'react';
import { createServiceAccountAction, type MachineState } from '@/actions/machines';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: MachineState = { ok: false, message: '' };
const SCOPES = ['db:read', 'db:write', 'auth:read', 'admin'] as const;

export function ServiceAccountForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(createServiceAccountAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border p-4">
      <input type="hidden" name="appId" value={appId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" placeholder="nightly-import" required className="w-48" />
        </div>

        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="ownerUserId">Owner</Label>
          <Input id="ownerUserId" name="ownerUserId" placeholder="defaults to you" />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ipAllowlist">IP allowlist</Label>
        <Input
          id="ipAllowlist"
          name="ipAllowlist"
          placeholder="203.0.113.7, 10.0.0.0/8"
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">
          Leave empty for no restriction. With entries present, a caller whose IP cannot be
          determined is refused rather than waved through.
        </p>
      </div>

      <fieldset className="flex flex-wrap gap-4">
        <legend className="text-sm font-medium">Scopes</legend>
        {SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name={scope} defaultChecked={scope === 'db:read'} />
            <span className="font-mono text-xs">{scope}</span>
          </label>
        ))}
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="description">Note</Label>
        <Input id="description" name="description" placeholder="what this process does" />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create service account'}
        </Button>
        {state.message === '' ? null : (
          <p className={state.ok ? 'text-sm' : 'text-destructive text-sm'}>{state.message}</p>
        )}
      </div>
    </form>
  );
}
