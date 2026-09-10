'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Shows a freshly issued key once. Nothing here is ever persisted client-side. */
export function RevealOnce({ rawKey, note }: { rawKey: string; note: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{note}</p>
      <div className="flex items-center gap-2">
        <code className="bg-background flex-1 overflow-x-auto rounded px-2 py-1 font-mono text-xs">
          {rawKey}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(rawKey);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Store it on your server only — never commit it and never ship it in a browser bundle.
      </p>
    </div>
  );
}
