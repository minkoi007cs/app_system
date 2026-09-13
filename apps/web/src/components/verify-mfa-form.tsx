'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { verifyChallengeAction, type MfaState } from '@/actions/mfa';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: MfaState = { ok: false, message: '' };

export function VerifyMfaForm() {
  const router = useRouter();
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
          <Button type="submit" disabled={pending}>
            {pending ? 'Checking…' : 'Verify'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
