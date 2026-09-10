import Link from 'next/link';
import { SignInForm } from '@/components/sign-in-form';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Unified-App-Infra</h1>
        <p className="text-muted-foreground text-sm">Sign in to the admin dashboard.</p>
      </div>
      <SignInForm />
      <p className="text-muted-foreground text-sm">
        No account yet?{' '}
        <Link className="underline underline-offset-4" href="/sign-up">
          Create one
        </Link>
      </p>
    </main>
  );
}
