'use client';

import { useActionState } from 'react';
import { createAppAction, type ActionState } from '@/actions/apps';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: ActionState = { ok: false, message: '' };

export function CreateAppForm() {
  const [state, action, pending] = useActionState(createAppAction, INITIAL);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Register an application</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="AI Study OS" required />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" name="slug" placeholder="learning-ai" pattern="[a-z0-9-]+" required />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" placeholder="optional" />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create'}
          </Button>
        </form>
        {state.message !== '' ? (
          <p className={`mt-3 text-sm ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
            {state.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
