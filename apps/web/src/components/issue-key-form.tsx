'use client';

import { useActionState } from 'react';
import { issueKeyAction, type IssueKeyState } from '@/actions/keys';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RevealOnce } from '@/components/reveal-once';

const INITIAL: IssueKeyState = { ok: false, message: '' };
const SCOPES = ['db:read', 'db:write', 'auth:read', 'admin'] as const;

export function IssueKeyForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(issueKeyAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Issue a key</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="appId" value={appId} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="name">Label</Label>
              <Input id="name" name="name" placeholder="production server" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="environment">Environment</Label>
              <select
                id="environment"
                name="environment"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                defaultValue="live"
              >
                <option value="live">live</option>
                <option value="test">test</option>
              </select>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Issuing…' : 'Issue key'}
            </Button>
          </div>
          <fieldset className="flex flex-wrap gap-4">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={scope} defaultChecked={scope === 'db:read'} />
                <span className="font-mono text-xs">{scope}</span>
              </label>
            ))}
          </fieldset>
        </form>

        {state.rawKey !== undefined ? <RevealOnce rawKey={state.rawKey} note={state.message} /> : null}
      </CardContent>
    </Card>
  );
}
