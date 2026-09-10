import { listAuditLogs } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { db } from '@/lib/db';
import { requireAdminSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  await requireAdminSession();
  const logs = await listAuditLogs(db(), { limit: 100 });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-muted-foreground text-sm">
          Statement text, parameter values and raw keys are never recorded — only fingerprints, counts
          and durations.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last {logs.length} events</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {log.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{log.action}</TableCell>
                    <TableCell className="text-xs">{log.actorType}</TableCell>
                    <TableCell>
                      <Badge variant={log.outcome === 'success' ? 'default' : 'destructive'}>
                        {log.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-md truncate font-mono text-xs">
                      {JSON.stringify(log.meta)}
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
