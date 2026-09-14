'use client';

import { useActionState, useState } from 'react';
import { createPolicyAction, type AccessState } from '@/actions/access';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const INITIAL: AccessState = { ok: false, message: '' };

const OPERATORS = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'is not null' },
] as const;

const SUBJECT_ATTRIBUTES = [
  { value: 'id', label: 'the signed-in user id' },
  { value: 'workspace_id', label: 'their workspace' },
  { value: 'app_id', label: 'this app' },
] as const;

const selectClass = 'border-input bg-background h-9 rounded-md border px-2 text-sm';

/**
 * One clause: `column` `op` (subject attribute | literal).
 *
 * Three of these, ANDed, cover the policies people actually write. A free-form tree editor would
 * be more powerful and much harder to read back — and a rule nobody can read at a glance is a rule
 * nobody notices is wrong.
 */
function Clause({ index }: { index: number }) {
  const [op, setOp] = useState('eq');
  const [source, setSource] = useState('subject');
  const needsValue = op !== 'is_null' && op !== 'is_not_null';

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`clause${index}Field`} className="text-xs">
          {index === 0 ? 'Column' : 'and column'}
        </Label>
        <Input
          id={`clause${index}Field`}
          name={`clause${index}Field`}
          placeholder={index === 0 ? 'owner_id' : 'optional'}
          className="w-44"
        />
      </div>

      <select
        name={`clause${index}Op`}
        className={selectClass}
        value={op}
        onChange={(event) => setOp(event.target.value)}
      >
        {OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>

      {needsValue ? (
        <>
          <select
            name={`clause${index}Source`}
            className={selectClass}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="subject">subject attribute</option>
            <option value="literal">a fixed value</option>
          </select>

          {source === 'subject' ? (
            <select name={`clause${index}Value`} className={selectClass} defaultValue="id">
              {SUBJECT_ATTRIBUTES.map((attribute) => (
                <option key={attribute.value} value={attribute.value}>
                  {attribute.label}
                </option>
              ))}
            </select>
          ) : (
            <Input name={`clause${index}Value`} placeholder="published" className="w-44" />
          )}
        </>
      ) : null}
    </div>
  );
}

export function PolicyForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState(createPolicyAction, INITIAL);
  const [shape, setShape] = useState('clauses');
  const [effect, setEffect] = useState('allow');

  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border p-4">
      <input type="hidden" name="appId" value={appId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="resource">Table</Label>
          <Input id="resource" name="resource" placeholder="notes" required className="w-44" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="action">Action</Label>
          <select id="action" name="action" className={selectClass} defaultValue="select">
            <option value="select">select</option>
            <option value="insert">insert</option>
            <option value="update">update</option>
            <option value="delete">delete</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="effect">Effect</Label>
          <select
            id="effect"
            name="effect"
            className={selectClass}
            value={effect}
            onChange={(event) => setEffect(event.target.value)}
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="priority">Priority</Label>
          <Input
            id="priority"
            name="priority"
            type="number"
            defaultValue={100}
            className="w-24"
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="conditionShape">Applies to</Label>
        <select
          id="conditionShape"
          name="conditionShape"
          className={selectClass + ' w-fit'}
          value={shape}
          onChange={(event) => setShape(event.target.value)}
        >
          <option value="clauses">rows matching the clauses below</option>
          <option value="always">every row</option>
          <option value="never">no row (a placeholder that grants nothing)</option>
        </select>
      </div>

      {shape === 'clauses' ? (
        <div className="flex flex-col gap-2 border-l-2 pl-3">
          <Clause index={0} />
          <Clause index={1} />
          <Clause index={2} />
        </div>
      ) : null}

      {shape === 'always' && effect === 'allow' ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          This allows every row of that table to every subject whose role permits the action. That
          is sometimes right — a public catalogue — but it is the setting most often chosen by
          mistake.
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="description">Note (optional)</Label>
        <Input id="description" name="description" placeholder="why this policy exists" />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add policy'}
        </Button>
        {state.message === '' ? null : (
          <p className={state.ok ? 'text-sm' : 'text-destructive text-sm'}>{state.message}</p>
        )}
      </div>
    </form>
  );
}
