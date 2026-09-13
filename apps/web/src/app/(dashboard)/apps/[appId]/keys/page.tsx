import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppById, listApiKeys } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { IssueKeyForm } from '@/components/issue-key-form';
import { KeyRowActions } from '@/components/key-row-actions';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export default async function KeysPage({ params }: { params: Promise<{ appId: string }> }) {
  await requireSuperAdmin();
  const { appId } = await params;

  const app = await getAppById(db(), appId);
  if (app === null) notFound();
  const keys = await listApiKeys(db(), appId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link className="text-muted-foreground text-sm underline underline-offset-4" href={`/apps/${appId}`}>
          ← {app.name}
        </Link>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="text-muted-foreground text-sm">
          Only a SHA-256 hash is stored. A key is shown once, at creation, and can never be recovered.
        </p>
      </header>

      <IssueKeyForm appId={appId} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{keys.length} key(s)</CardTitle>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">No keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs">{key.keyPrefix}••••</TableCell>
                    <TableCell>
                      <Badge variant={key.keyType === 'secret' ? 'destructive' : 'secondary'}>
                        {key.keyType === 'secret' ? 'secret' : 'publishable'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{key.scopes.join(', ')}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {key.lastUsedAt === null ? 'never' : key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </TableCell>
                    <TableCell>
                      {key.revokedAt === null ? (
                        <Badge>active</Badge>
                      ) : (
                        <Badge variant="outline">revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {key.revokedAt === null ? <KeyRowActions appId={appId} keyId={key.id} /> : null}
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
