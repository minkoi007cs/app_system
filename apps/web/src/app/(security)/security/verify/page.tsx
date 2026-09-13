import { redirect } from 'next/navigation';
import { evaluateAdminGate } from '@/lib/admin';
import { listPasskeys } from '@infra/db';
import { db } from '@/lib/db';
import { VerifyMfaForm } from '@/components/verify-mfa-form';

export const dynamic = 'force-dynamic';

export default async function VerifyPage() {
  const gate = await evaluateAdminGate();
  if (gate.state === 'anonymous') redirect('/sign-in');
  if (gate.state === 'not-allowlisted') redirect('/not-authorised');
  if (gate.state === 'needs-enrolment') redirect('/security/enrol');
  if (gate.state === 'ok') redirect('/apps');

  const passkeys = await listPasskeys(db(), gate.context.userId);

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Confirm it&apos;s you</h1>
        <p className="text-muted-foreground text-sm">
          Enter the six-digit code from your authenticator app, or one of your backup codes.
          Administrator sessions re-confirm every 8 hours.
        </p>
      </div>
      <VerifyMfaForm hasPasskey={passkeys.length > 0} />
    </>
  );
}
