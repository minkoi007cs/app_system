import { evaluateAdminGate } from '@/lib/admin';
import { redirect } from 'next/navigation';
import { EnrolMfaFlow } from '@/components/enrol-mfa-flow';

export const dynamic = 'force-dynamic';

export default async function EnrolPage() {
  const gate = await evaluateAdminGate();
  if (gate.state === 'anonymous') redirect('/sign-in');
  if (gate.state === 'not-allowlisted') redirect('/not-authorised');
  if (gate.state === 'ok') redirect('/apps');

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Set up two-factor authentication</h1>
        <p className="text-muted-foreground text-sm">
          Required for every platform administrator. A password alone cannot protect the key that
          decrypts every application&apos;s database credentials.
        </p>
      </div>
      <EnrolMfaFlow />
    </>
  );
}
