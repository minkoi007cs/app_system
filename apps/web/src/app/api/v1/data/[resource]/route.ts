/**
 * POST /api/v1/data/:resource — the endpoint a browser is allowed to call.
 *
 * This is the counterpart to `/api/v1/query`, and the split is the point of Phase 7:
 *
 *   /api/v1/query        raw SQL · `sk_` only · no rules engine · for a trusted server
 *   /api/v1/data/:res    query DSL · `pk_` or `sk_` · every statement carries a policy condition
 *
 * A publishable key ships inside a browser bundle, so it is public by construction. That is safe
 * here only because a `pk_` caller cannot express arbitrary SQL and cannot escape the row filter:
 * the statement is built by the compiler, and the condition the policy engine returns is ANDed in
 * by the same call that builds it.
 *
 * Where each input comes from, and why:
 *   appId      — the verified API key. Never the body, never a header.
 *   subject    — the verified access token (`x-infra-access-token`). Never the body.
 *   dialect    — the app's own database config, resolved server-side.
 *   resource   — the URL path, or the body; either way it must be a bare identifier.
 *   values     — the body. This is the only part of the request that is allowed to be arbitrary,
 *                and every one of them leaves as a bound parameter.
 */
import { bearerFromHeader, planQuery, verifyToken, type GatewaySubject } from '@infra/auth';
import { InfraError, parseQuerySpec } from '@infra/core';
import { getMembership, recordAuditAsync } from '@infra/db';
import { db } from '@/lib/db';
import { recordDecision } from '@/lib/decision-log';
import { corsHeaders, preflightResponse } from '@/lib/cors';
import { clientIp, requireApiKey, userAgent } from '@/lib/guard';
import { tokenIssuer } from '@/lib/issuer';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';
import { resolver } from '@/lib/resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAYLOAD_BYTES = 128 * 1024;

export async function OPTIONS(request: Request): Promise<Response> {
  return preflightResponse(request.headers.get('origin'), [request.headers.get('origin') ?? '']);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ resource: string }> },
): Promise<Response> {
  const requestId = newRequestId();
  const origin = request.headers.get('origin');
  const started = Date.now();

  try {
    // Both key kinds are accepted; the rules engine is what makes `pk_` safe here, not the key.
    const caller = await requireApiKey(request, 'db:read');
    const cors = corsHeaders(origin, caller.app.allowedOrigins);

    if (origin !== null && origin !== '' && !caller.app.allowedOrigins.includes(origin)) {
      throw new InfraError('FORBIDDEN_SCOPE', 'origin is not registered for this application', {
        details: { origin },
      });
    }

    const raw = await request.text();
    if (raw.length > MAX_PAYLOAD_BYTES) {
      throw new InfraError('VALIDATION_FAILED', `request body exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }

    let body: unknown;
    try {
      body = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      throw new InfraError('VALIDATION_FAILED', 'request body must be JSON');
    }

    const { resource } = await context.params;
    const spec = parseQuerySpec(body, resource);

    // A write needs the write scope; the key's scopes are checked again for the real action rather
    // than assumed from the `db:read` used to authenticate the request.
    if (spec.action !== 'select' && !caller.key.scopes.includes('db:write')) {
      throw new InfraError('FORBIDDEN_SCOPE', `key does not carry db:write for ${spec.action}`);
    }

    const subject = await resolveSubject(request, caller);

    const adapter = await resolver().resolve(caller.appId);

    let plan;
    try {
      plan = await planQuery(db(), {
        appId: caller.appId,
        subject,
        spec,
        dialect: adapter.dialect,
      });
    } catch (error) {
      // A denial is a decision, and the one people actually come looking for. Recorded before the
      // error propagates, so a refused request is never invisible.
      recordDecision({
        appId: caller.appId,
        actorType: subject.type === 'user' ? 'admin' : 'api_key',
        actorId: subject.id,
        resource: spec.resource,
        action: spec.action,
        allowed: false,
        overheadMs: Date.now() - started,
        totalMs: Date.now() - started,
        deniedBy: InfraError.is(error) ? ((error.details['deniedBy'] as 'rbac' | 'abac') ?? null) : null,
        reason: InfraError.is(error) ? error.message : 'denied',
        ipAddress: clientIp(request),
      });
      throw error;
    }

    const result = await adapter.query({ sql: plan.query.sql, params: plan.query.params });

    recordDecision({
      appId: caller.appId,
      actorType: subject.type === 'user' ? 'admin' : 'api_key',
      actorId: subject.id,
      resource: spec.resource,
      action: spec.action,
      allowed: true,
      // The rules engine's own time, not the tenant database's — see GatewayPlan.overheadMs.
      overheadMs: plan.overheadMs,
      totalMs: Date.now() - started,
    });

    recordAuditAsync(db(), {
      appId: caller.appId,
      actorType: subject.type === 'user' ? 'admin' : 'api_key',
      actorId: subject.id,
      action: 'db.query.executed',
      targetType: spec.resource,
      ipAddress: clientIp(request),
      userAgent: userAgent(request),
      // Shape, counts and timings. No statement text, no parameters — the shape is built from the
      // spec's structure and cannot contain a value.
      meta: {
        shape: plan.shape,
        action: spec.action,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
        overheadMs: Math.round(plan.overheadMs * 100) / 100,
        gatewayMs: Date.now() - started,
        policies: plan.access.decision?.matched ?? [],
      },
    });

    const response = jsonOk(
      { rows: result.rows, rowCount: result.rowCount, durationMs: result.durationMs },
      requestId,
    );
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

/**
 * Who is asking.
 *
 * With a user access token the subject is that user — and their membership of this app is
 * re-checked here rather than trusted from the token, so a token that outlived the membership it
 * was minted under stops working immediately instead of at its own expiry.
 *
 * Without one, the only other identity this platform recognises is a service account, and the key
 * has to belong to one. A bare `pk_` key with nobody signed in is refused rather than treated as
 * an anonymous subject: anonymous read access is a thing an app should have to configure on
 * purpose, and there is no mechanism for it yet, so the safe answer is no.
 */
async function resolveSubject(
  request: Request,
  caller: { appId: string; serviceAccountId: string | null },
): Promise<GatewaySubject> {
  const header = request.headers.get('x-infra-access-token');
  const accessToken = header === null ? null : (bearerFromHeader(header) ?? header.trim());

  if (accessToken === null || accessToken === '') {
    if (caller.serviceAccountId === null) {
      throw new InfraError(
        'UNAUTHENTICATED',
        'send a user access token in x-infra-access-token, or use a service account key',
      );
    }
    return { type: 'service_account', id: caller.serviceAccountId, workspaceId: null };
  }

  const claims = await verifyToken(db(), accessToken, {
    issuer: tokenIssuer(),
    audience: caller.appId,
    expectedType: 'access',
  });

  const membership = await getMembership(db(), caller.appId, claims.sub);
  if (membership === null) {
    throw new InfraError('FORBIDDEN_SCOPE', 'that user is not a member of this application');
  }

  return { type: 'user', id: claims.sub, workspaceId: claims.wid };
}
