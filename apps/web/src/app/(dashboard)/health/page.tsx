import Link from 'next/link';
import { listAppsForOwner, listDatabaseConfigs } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HealthButton } from '@/components/health-button';
import { db } from '@/lib/db';
import { requireAdminSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const session = await requireAdminSession();
  const apps = await listAppsForOwner(db(), session.userId);

  const rows = await Promise.all(
    apps.map(async (app) => ({ app, configs: await listDatabaseConfigs(db(), app.id) })),
  );

  const down = rows.filter((row) => row.configs.some((config) => config.healthStatus === 'down')).length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">Health</h1>
        <p className="text-muted-foreground text-sm">
          Latency under 300ms is healthy, under 1500ms is degraded. Free-tier databases sleep when
          idle, so the first check after a pause is usually slow.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {rows.length} app(s) · {down} with a database down
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No applications yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Application</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Last checked</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ app, configs }) => {
                  const primary = configs.find((config) => config.isPrimary) ?? configs[0];
                  return (
                    <TableRow key={app.id}>
                      <TableCell>
                        <Link className="font-medium underline underline-offset-4" href={`/apps/${app.id}`}>
                          {app.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs">{primary?.provider ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={primary?.healthStatus === 'healthy' ? 'default' : 'outline'}>
                          {primary?.healthStatus ?? 'no database'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {primary?.healthLatencyMs === null || primary === undefined
                          ? '—'
                          : `${primary.healthLatencyMs}ms`}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {primary?.healthCheckedAt == null
                          ? 'never'
                          : primary.healthCheckedAt.toISOString().slice(0, 16).replace('T', ' ')}
                      </TableCell>
                      <TableCell className="text-right">
                        {primary === undefined ? null : <HealthButton appId={app.id} />}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
