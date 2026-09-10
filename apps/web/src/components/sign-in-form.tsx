'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

const SOCIALS = [
  { id: 'github', label: 'GitHub' },
  { id: 'google', label: 'Google' },
  { id: 'microsoft', label: 'Microsoft' },
] as const;

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const result = await authClient.signIn.email({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? 'sign in failed');
      return;
    }
    router.push('/apps');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={onSubmit} className="flex flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {error !== null ? <p className="text-destructive text-sm">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="flex items-center gap-2">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <div className="flex flex-col gap-2">
        {SOCIALS.map((social) => (
          <Button
            key={social.id}
            variant="outline"
            type="button"
            onClick={() => {
              void authClient.signIn.social({ provider: social.id, callbackURL: '/apps' });
            }}
          >
            Continue with {social.label}
          </Button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        A social button only works once that provider is configured in the environment.
      </p>
    </div>
  );
}
