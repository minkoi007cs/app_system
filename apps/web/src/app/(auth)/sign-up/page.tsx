import Link from 'next/link';
import { SignUpForm } from '@/components/sign-up-form';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create an admin account</h1>
        <p className="text-muted-foreground text-sm">Password must be at least 12 characters.</p>
      </div>
      <SignUpForm />
      <p className="text-muted-foreground text-sm">
        Already have one?{' '}
        <Link className="underline underline-offset-4" href="/sign-in">
          Sign in
        </Link>
      </p>
    </main>
  );
}
