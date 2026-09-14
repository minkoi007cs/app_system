import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppById, listServiceAccounts, listWorkspaces } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ServiceAccountForm } from '@/components/service-account-form';
import { ServiceAccountRowActions } from '@/components/service-account-row-actions';
import { WorkspaceForm } from '@/components/workspace-form';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export default async function MachinesPage({ params }: { params: Promise<{ appId: string }> }) {
  await requireSuperAdmin();
  const { appId } = await params;

  const app = await getAppById(db(), appId);
  if (app === null) notFound();

  const [accounts, workspaces] = await Promise.all([
    listServiceAccounts(db(), appId),
    listWorkspaces(db(), appId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link className="text-muted-foreground text-sm underline underline-offset-4" href={`/apps/${appId}`}>
          ← {app.name}
        </Link>
        <h1 className="text-xl font-semibold">Machines &amp; workspaces</h1>
        <p className="text-muted-foreground text-sm">
          A service account is an identity for a process. Every one of them has a human owner,
          because a credential nobody answers for is the one still working two years after its
          author has left.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service accounts ({accounts.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ServiceAccountForm appId={appId} />

          {accounts.length === 0 ? (
            <p className="text-muted-foreground text-sm">No service accounts yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>IP allowlist</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell className="font-medium">
                      {account.name}
                      <div className="text-muted-foreground font-mono text-xs">{account.id}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{account.ownerUserId}</TableCell>
                    <TableCell className="font-mono text-xs">{account.scopes.join(' ')}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {account.ipAllowlist.length === 0 ? (
                        <span className="text-amber-600">anywhere</span>
                      ) : (
                        account.ipAllowlist.join(', ')
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.status === 'active' ? 'secondary' : 'outline'}>
                        {account.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ServiceAccountRowActions
                        appId={appId}
                        accountId={account.id}
                        active={account.status === 'active'}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <p className="text-muted-foreground text-xs">
            Machine keys are always <code>sk_</code>, and <code>client_credentials</code> returns a
            15-minute access token with no refresh token — a process that already holds the key
            that minted it does not need a second long-lived credential.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspaces ({workspaces.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <WorkspaceForm appId={appId} />

          {workspaces.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No workspaces. Every <code>workspace_id</code> in the schema is nullable, so an app
              that never uses them costs nothing — and one that starts using them later needs no
              migration.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Slug</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspaces.map((workspace) => (
                  <TableRow key={workspace.id}>
                    <TableCell className="font-mono text-xs">{workspace.slug}</TableCell>
                    <TableCell>{workspace.name}</TableCell>
                    <TableCell className="text-xs">
                      {workspace.createdAt.toISOString().slice(0, 10)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
