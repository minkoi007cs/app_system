import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppById, getPrimaryDatabaseConfig, listActiveApiKeys, listMembersOfApp } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OriginsForm } from '@/components/origins-form';
import { StatusButtons } from '@/components/status-buttons';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export default async function AppOverviewPage({ params }: { params: Promise<{ appId: string }> }) {
  await requireSuperAdmin();
  const { appId } = await params;

  const app = await getAppById(db(), appId);
  if (app === null) notFound();

  const [keys, config, members] = await Promise.all([
    listActiveApiKeys(db(), appId),
    getPrimaryDatabaseConfig(db(), appId),
    listMembersOfApp(db(), appId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{app.name}</h1>
        <Badge variant="outline" className="font-mono text-xs">
          {app.slug}
        </Badge>
        <Badge>{app.status}</Badge>
        <div className="ml-auto flex gap-2">
          <Link className="text-sm underline underline-offset-4" href={`/apps/${appId}/keys`}>
            API keys
          </Link>
          <Link className="text-sm underline underline-offset-4" href={`/apps/${appId}/access`}>
            Access
          </Link>
          <Link className="text-sm underline underline-offset-4" href={`/apps/${appId}/machines`}>
            Machines
          </Link>
          <Link className="text-sm underline underline-offset-4" href={`/apps/${appId}/database`}>
            Database
          </Link>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Active API keys</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{keys.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Database</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {config === null ? (
              <span className="text-muted-foreground">not configured</span>
            ) : (
              <span>
                {config.provider} · <span className="text-muted-foreground">{config.healthStatus}</span>
              </span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Members</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{members.length}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allowed browser origins</CardTitle>
        </CardHeader>
        <CardContent>
          <OriginsForm appId={appId} origins={app.allowedOrigins} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <StatusButtons appId={appId} status={app.status} />
        </CardContent>
      </Card>
    </div>
  );
}
