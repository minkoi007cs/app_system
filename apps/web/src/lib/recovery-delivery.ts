/**
 * Where a recovery link goes.
 *
 * No mailer is wired yet (Phase 8 — risk R8 in process.md). Until one is, the link is written to
 * the server console in development so the flow is testable end to end, and in production the
 * absence of a transport is recorded loudly rather than silently swallowed.
 *
 * The one rule that outlives whichever transport arrives: the raw token is never returned to the
 * caller of the HTTP endpoint. If it were, "forgot password" would become "reset anyone's password"
 * for whoever can reach the API.
 */
export interface RecoveryLink {
  email: string;
  url: string;
}

export function recoveryUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/recover?token=${encodeURIComponent(token)}`;
}

export function deliverRecoveryLink(link: RecoveryLink): void {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[recovery] no mail transport configured — a recovery link was generated but not delivered',
    );
    return;
  }

  console.info(`[recovery] link for ${link.email}: ${link.url}`);
}
