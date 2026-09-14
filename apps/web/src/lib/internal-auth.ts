/**
 * The platform's own token, for endpoints a scheduler calls rather than a tenant.
 *
 * Separate from every tenant credential on purpose: these endpoints are not scoped to an app, and
 * an API key that could reach them would be an API key that could make the platform emit traffic
 * or delete rows on demand. Compared in constant time, and an unset token means **nobody** passes
 * rather than everybody.
 */
import { timingSafeEqual } from 'node:crypto';
import { InfraError } from '@infra/core';

export function assertInternalToken(request: Request): void {
  const expected = process.env.INFRA_INTERNAL_TOKEN ?? '';

  // Unset is a closed door, not an open one. A deployment that forgets the variable gets 401s in
  // its scheduler logs, which is noticed; the alternative is a silently public endpoint, which is
  // not.
  if (expected === '') {
    throw new InfraError('UNAUTHENTICATED', 'INFRA_INTERNAL_TOKEN is not configured');
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InfraError('UNAUTHENTICATED', 'internal endpoint requires the platform token');
  }
}
