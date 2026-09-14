import { activeImpersonation, expireImpersonations } from '@infra/db';
import { db } from '@/lib/db';
import { StopImpersonationButton } from './stop-impersonation-button';

/**
 * The banner is not decoration — it is the control that makes impersonation safe to use.
 *
 * Without a permanent, unmissable marker an admin forgets which account they are looking at, and
 * the next thing they do lands on a customer's data believing it is their own. So it renders on
 * every dashboard page, states who is being impersonated and until when, and carries the exit.
 */
export async function ImpersonationBanner({ adminId }: { adminId: string }) {
  // Close anything that ran out before asking what is active, so an expired session can never
  // render as live.
  await expireImpersonations(db()).catch(() => 0);
  const session = await activeImpersonation(db(), adminId);
  if (session === null) return null;

  const minutesLeft = Math.max(Math.ceil((session.expiresAt.getTime() - Date.now()) / 60_000), 0);

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-semibold">Impersonating</span>{' '}
        <span className="font-mono text-xs">{session.targetUserId}</span>
        <span className="text-muted-foreground">
          {' '}
          · {session.readOnly ? 'read-only' : 'read-write'} · ends in {minutesLeft}m
        </span>
        <p className="text-muted-foreground truncate text-xs">Reason: {session.reason}</p>
      </div>
      <StopImpersonationButton />
    </div>
  );
}
