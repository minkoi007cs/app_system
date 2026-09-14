'use client';

import { useActionState } from 'react';
import { assignRoleAction, type AccessState } from '@/actions/access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: AccessState = { ok: false, message: '' };
const selectClass = 'border-input bg-background h-9 rounded-md border px-2 text-sm';

export function AssignRoleForm({
  appId,
  roles,
}: {
  appId: string;
  roles: Array<{ id: string; key: string }>;
}) {
  const [state, action, pending] = useActionState(assignRoleAction, INITIAL);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border p-4">
      <input type="hidden" name="appId" value={appId} />

      <div className="grid gap-1.5">
        <Label htmlFor="subjectType">Subject</Label>
        <select id="subjectType" name="subjectType" className={selectClass} defaultValue="user">
          <option value="user">user</option>
          <option value="service_account">service account</option>
        </select>
      </div>

      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="subjectId">Id</Label>
        <Input id="subjectId" name="subjectId" placeholder="user id or service account id" required />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="roleId">Role</Label>
        <select id="roleId" name="roleId" className={selectClass} required>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.key}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="expiresInDays">Expires in</Label>
        <select id="expiresInDays" name="expiresInDays" className={selectClass} defaultValue="0">
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="0">never</option>
        </select>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Granting…' : 'Grant'}
      </Button>

      <p className="text-muted-foreground w-full text-xs">
        A grant that expires on its own is the safest kind — nobody has to remember to take it away.
      </p>

      {state.message === '' ? null : (
        <p className={state.ok ? 'w-full text-sm' : 'text-destructive w-full text-sm'}>{state.message}</p>
      )}
    </form>
  );
}
