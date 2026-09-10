import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppById, listDatabaseConfigs } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DatabaseForm } from '@/components/database-form';
import { HealthButton } from '@/components/health-button';
import { db } from '@/lib/db';
import { requireAdminSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DatabasePage({ params }: { params: Promise<{ appId: string }> }) {
  await requireAdminSession();
  const { appId } = await params;

  const app = await getAppById(db(), appId);
  if (app === null) notFound();
  const configs = await listDatabaseConfigs(db(), appId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link className="text-muted-foreground text-sm underline underline-offset-4" href={`/apps/${appId}`}>
          ← {app.name}
        </Link>
        <h1 className="text-xl font-semibold">Database</h1>
        <p className="text-muted-foreground text-sm">
          The connection string is encrypted with AES-256-GCM before it is written, and decrypted only
          in memory when a query runs.
        </p>
      </header>

      <DatabaseForm appId={appId} />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Configured databases</CardTitle>
          <HealthButton appId={appId} />
        </CardHeader>
        <CardContent>
          {configs.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No database yet — this app cannot serve queries until one is attached.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Host</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {configs.map((config) => (
                  <TableRow key={config.id}>
                    <TableCell className="font-medium">
                      {config.label}
                      {config.isPrimary ? <Badge className="ml-2">primary</Badge> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {config.provider} · {config.dialect}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{config.hostHint ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={config.healthStatus === 'healthy' ? 'default' : 'outline'}>
                        {config.healthStatus}
                        {config.healthLatencyMs === null ? '' : ` · ${config.healthLatencyMs}ms`}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {config.healthCheckedAt === null
                        ? 'never'
                        : config.healthCheckedAt.toISOString().slice(0, 16).replace('T', ' ')}
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
