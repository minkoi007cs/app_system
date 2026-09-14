import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compileCondition, type PolicyCondition, type PolicySubject } from '@infra/core';
import { getAppById, listPolicies, listRoleAssignments, listRoles } from '@infra/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AssignRoleForm } from '@/components/assign-role-form';
import { CreateRoleForm } from '@/components/create-role-form';
import { PolicyForm } from '@/components/policy-form';
import { PolicyRowActions } from '@/components/policy-row-actions';
import { AssignmentRowActions } from '@/components/assignment-row-actions';
import { db } from '@/lib/db';
import { requireSuperAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/**
 * A stand-in subject used only to render each policy's WHERE fragment.
 *
 * The preview is the point of this page. A rules screen that lists policies by name tells an admin
 * nothing about what they actually do; showing the compiled SQL — with the subject's own values as
 * visible placeholders — is what makes "this policy allows more than I thought" catchable before
 * it ships rather than after.
 */
const PREVIEW_SUBJECT: PolicySubject = {
  id: ':current_user',
  appId: ':this_app',
  roles: [':role'],
  workspaceId: ':workspace',
};

function previewOf(condition: PolicyCondition): string {
  try {
    const compiled = compileCondition(condition, PREVIEW_SUBJECT, 'postgres');
    // Substitute the parameters back in for display only — this string never runs.
    return compiled.params.reduce<string>(
      (sql, param, index) => sql.replace(`$${index + 1}`, String(param)),
      compiled.sql,
    );
  } catch {
    return 'could not compile — this policy is malformed';
  }
}

export default async function AccessPage({ params }: { params: Promise<{ appId: string }> }) {
  await requireSuperAdmin();
  const { appId } = await params;

  const app = await getAppById(db(), appId);
  if (app === null) notFound();

  const [roles, assignments, policyRows] = await Promise.all([
    listRoles(db(), appId),
    listRoleAssignments(db(), appId),
    listPolicies(db(), appId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link className="text-muted-foreground text-sm underline underline-offset-4" href={`/apps/${appId}`}>
          ← {app.name}
        </Link>
        <h1 className="text-xl font-semibold">Access</h1>
        <p className="text-muted-foreground text-sm">
          Roles decide <em>whether</em> a subject may touch a resource. Policies decide{' '}
          <em>which rows</em>. Both must pass, and the default is deny.
        </p>
      </header>

      {/* ── policies first: they are the part people get wrong ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Row policies ({policyRows.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <PolicyForm appId={appId} />

          {policyRows.length === 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              No policies yet — every data request through <code>/api/v1/data</code> is being denied.
              That is the safe default, and it is also why a new app reads nothing until you write
              one here.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resource</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Effect</TableHead>
                  <TableHead>Compiles to</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {policyRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.resource}</TableCell>
                    <TableCell>{row.action}</TableCell>
                    <TableCell>
                      <Badge variant={row.effect === 'deny' ? 'destructive' : 'secondary'}>
                        {row.effect}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md font-mono text-xs break-all">
                      {previewOf(row.condition)}
                    </TableCell>
                    <TableCell>{row.priority}</TableCell>
                    <TableCell>
                      <Badge variant={row.enabled ? 'secondary' : 'outline'}>
                        {row.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <PolicyRowActions appId={appId} policyId={row.id} enabled={row.enabled} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <p className="text-muted-foreground text-xs">
            An explicit <code>deny</code> beats every <code>allow</code>, whatever the priority. A
            resource no policy mentions is denied.
          </p>
        </CardContent>
      </Card>

      {/* ── roles ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Roles ({roles.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CreateRoleForm appId={appId} />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Origin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-mono text-xs">{role.key}</TableCell>
                  <TableCell>{role.name}</TableCell>
                  <TableCell className="font-mono text-xs">{role.permissions.join(' ')}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{role.isSystem ? 'system' : 'custom'}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── grants ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Grants ({assignments.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <AssignRoleForm appId={appId} roles={roles.map((r) => ({ id: r.id, key: r.key }))} />

          {assignments.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody has been granted a role here yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map((assignment) => (
                  <TableRow key={assignment.id}>
                    <TableCell className="font-mono text-xs">
                      {assignment.subjectId}
                      <span className="text-muted-foreground"> · {assignment.subjectType}</span>
                    </TableCell>
                    <TableCell>{assignment.roleKey}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {assignment.permissions.join(' ')}
                    </TableCell>
                    <TableCell className="text-xs">
                      {assignment.expiresAt === null ? (
                        <span className="text-amber-600">never</span>
                      ) : (
                        assignment.expiresAt.toISOString().slice(0, 10)
                      )}
                    </TableCell>
                    <TableCell>
                      <AssignmentRowActions appId={appId} assignmentId={assignment.id} />
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
