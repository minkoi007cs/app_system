import { listMfaFactors, listTrustedDevices, listUserSessions } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AddPasskeyButton } from '@/components/add-passkey-button';
import { FactorActions } from '@/components/factor-actions';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

function when(value: Date | null): string {
  return value === null ? '—' : value.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function SecuritySessionsPage() {
  const admin = await requireSuperAdmin();

  const [factors, devices, sessions] = await Promise.all([
    listMfaFactors(db(), admin.userId),
    listTrustedDevices(db(), admin.userId),
    listUserSessions(db(), admin.userId),
  ]);

  return (
    <div className="flex w-full flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as {admin.email} · {admin.role}
        </p>
      </header>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Second factors</CardTitle>
          <AddPasskeyButton />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {factors.map((factor) => (
                <TableRow key={factor.id}>
                  <TableCell className="font-mono text-xs">{factor.type}</TableCell>
                  <TableCell>{factor.label}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{when(factor.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{when(factor.lastUsedAt)}</TableCell>
                  <TableCell>
                    {factor.verifiedAt === null ? (
                      <Badge variant="outline">pending</Badge>
                    ) : (
                      <Badge>{factor.isPrimary ? 'primary' : 'active'}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <FactorActions
                      factorId={factor.id}
                      canRemove={factors.filter((f) => f.verifiedAt !== null).length > 1}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {factors.some((factor) => factor.type === 'totp' && factor.verifiedAt !== null) ? (
            <p className="text-muted-foreground mt-3 text-xs">
              Backup codes left:{' '}
              {factors
                .filter((factor) => factor.type === 'totp')
                .reduce((total, factor) => total + factor.backupCodeHashes.length, 0)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Remembered devices ({devices.length})</CardTitle>
          <FactorActions forgetDevices />
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              None. Every sign-in on every browser asks for a second factor.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Trusted until</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell>{device.label ?? 'Browser'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{when(device.lastSeenAt)}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{when(device.trustedUntil)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active sessions ({sessions.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>Second factor</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="text-muted-foreground text-xs">{when(session.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{when(session.expiresAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{session.ipAddress ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {when(session.mfaVerifiedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {session.id === admin.sessionId ? (
                      <Badge variant="secondary">this device</Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
