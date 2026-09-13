import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default function NotAuthorisedPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4" />
          Not a platform administrator
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          This account is not listed in <code className="font-mono text-xs">INFRA_SUPER_ADMIN_EMAILS</code>.
          That list lives in the environment and cannot be changed from this dashboard — deliberately,
          since whoever holds this level can decrypt every application&apos;s database credentials.
        </p>
        <p className="text-muted-foreground">
          To grant access, add the email to that variable and restart the server.
        </p>
        <Link className="underline underline-offset-4" href="/sign-in">
          Sign in with a different account
        </Link>
      </CardContent>
    </Card>
  );
}
