'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { verifyChallengeAction, type MfaState } from '@/actions/mfa';
import { Button } from '@/components/ui/button';
import { PasskeyChallengeButton } from '@/components/passkey-challenge-button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: MfaState = { ok: false, message: '' };

export function VerifyMfaForm({ hasPasskey }: { hasPasskey: boolean }) {
  const router = useRouter();
  const [remember, setRemember] = useState(false);
  const [state, action, pending] = useActionState(verifyChallengeAction, INITIAL);

  useEffect(() => {
    if (state.ok) {
      router.push('/apps');
      router.refresh();
    }
  }, [state.ok, router]);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={action} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              name="code"
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="123456 or ABCD-EFGH"
              autoFocus
              required
            />
          </div>
          {state.message !== '' ? (
            <p className={state.ok ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}>
              {state.message}
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember this browser for 30 days
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? 'Checking…' : 'Verify'}
          </Button>
        </form>

        {hasPasskey ? (
          <div className="mt-4 flex flex-col gap-2 border-t pt-4">
            <PasskeyChallengeButton rememberDevice={remember} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
