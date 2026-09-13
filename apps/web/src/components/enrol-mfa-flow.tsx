'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { activateEnrolmentAction, startEnrolmentAction, type MfaState } from '@/actions/mfa';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: MfaState = { ok: false, message: '' };

export function EnrolMfaFlow() {
  const router = useRouter();
  const [start, setStart] = useState<MfaState | null>(null);
  const [starting, setStarting] = useState(false);
  const [state, action, pending] = useActionState(activateEnrolmentAction, INITIAL);

  if (state.backupCodes !== undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Save your backup codes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm">{state.message}</p>
          <ul className="bg-muted grid grid-cols-2 gap-1 rounded-md p-3 font-mono text-sm">
            {state.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            Each one works once, and only if you lose your authenticator app. Keep them somewhere
            other than the device that holds the app.
          </p>
          <Button
            onClick={() => {
              router.push('/apps');
              router.refresh();
            }}
          >
            I&apos;ve saved them — continue
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (start?.secret === undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-muted-foreground text-sm">
            You&apos;ll need an authenticator app: Google Authenticator, 1Password, Raycast, or any
            other TOTP app.
          </p>
          {start?.ok === false ? <p className="text-destructive text-sm">{start.message}</p> : null}
          <Button
            disabled={starting}
            onClick={async () => {
              setStarting(true);
              setStart(await startEnrolmentAction());
              setStarting(false);
            }}
          >
            {starting ? 'Preparing…' : 'Start setup'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add this to your authenticator app</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label>Setup key</Label>
          <code className="bg-muted block overflow-x-auto rounded-md p-3 font-mono text-sm tracking-wider">
            {start.secret}
          </code>
          <p className="text-muted-foreground text-xs">
            Type this in, or paste the full link below into an app that accepts one.
          </p>
          <code className="text-muted-foreground block overflow-x-auto rounded-md text-[11px]">
            {start.otpauthUri}
          </code>
        </div>

        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="factorId" value={start.factorId ?? ''} />
          <div className="grid gap-1.5">
            <Label htmlFor="code">Six-digit code</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,8}"
              placeholder="123456"
              required
            />
          </div>
          {state.message !== '' && !state.ok ? (
            <p className="text-destructive text-sm">{state.message}</p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? 'Checking…' : 'Turn on two-factor'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
