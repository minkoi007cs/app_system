import Link from 'next/link';
import { listAppsForOwner } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CreateAppForm } from '@/components/create-app-form';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

const STATUS_VARIANT = {
  active: 'default',
  suspended: 'secondary',
  archived: 'outline',
} as const;

export default async function AppsPage() {
  const session = await requireSuperAdmin();
  const apps = await listAppsForOwner(db(), session.userId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">Applications</h1>
        <p className="text-muted-foreground text-sm">
          Each application gets its own isolated database and its own API keys.
        </p>
      </header>

      <CreateAppForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{apps.length} registered</CardTitle>
        </CardHeader>
        <CardContent>
          {apps.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet — register your first app above.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell>
                      <Link className="font-medium underline underline-offset-4" href={`/apps/${app.id}`}>
                        {app.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{app.slug}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[app.status]}>{app.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {app.createdAt.toISOString().slice(0, 10)}
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
