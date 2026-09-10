'use client';

import { useActionState } from 'react';
import { saveDatabaseAction, type DatabaseActionState } from '@/actions/database';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: DatabaseActionState = { ok: false, message: '' };

const PLACEHOLDER: Record<string, string> = {
  neon: 'postgresql://user:password@ep-xxx.neon.tech/db?sslmode=require',
  supabase: 'postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres',
  turso: 'libsql://db-name.turso.io?authToken=...',
};

export function DatabaseForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(saveDatabaseAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attach a database</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="appId" value={appId} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="grid gap-1.5">
              <Label htmlFor="provider">Provider</Label>
              <select
                id="provider"
                name="provider"
                defaultValue="neon"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              >
                <option value="neon">Neon (PostgreSQL)</option>
                <option value="supabase">Supabase (PostgreSQL)</option>
                <option value="turso">Turso (LibSQL)</option>
              </select>
            </div>
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="label">Label</Label>
              <Input id="label" name="label" placeholder="primary" defaultValue="primary" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="connectionString">Connection string</Label>
            <Input
              id="connectionString"
              name="connectionString"
              type="password"
              autoComplete="off"
              placeholder={PLACEHOLDER['neon']}
              required
            />
            <p className="text-muted-foreground text-xs">
              Supabase: use the transaction pooler on port 6543. Turso: keep the authToken in the URL.
            </p>
          </div>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Encrypting…' : 'Save & encrypt'}
            </Button>
          </div>
          {state.message !== '' ? (
            <p className={`text-sm ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
              {state.message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
