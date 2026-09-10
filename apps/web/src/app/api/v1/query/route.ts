/**
 * POST /api/v1/query — the single data endpoint child apps use.
 *
 * Contract: { sql: string, params?: unknown[] }
 * The SQL is a static statement written by the child app; every value travels in `params`
 * and is bound by the driver. Nothing is ever concatenated into the statement.
 */
import { InfraError } from '@infra/core';
import { recordAuditAsync, sqlFingerprint } from '@infra/db';
import { db } from '@/lib/db';
import { clientIp, requireApiKey } from '@/lib/guard';
import { jsonOk, newRequestId, toErrorResponse } from '@/lib/response';
import { resolver } from '@/lib/resolver';
import { sqlIntent } from '@/lib/sql-intent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAYLOAD_BYTES = 64 * 1024;

interface QueryBody {
  sql?: unknown;
  params?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const started = Date.now();

  try {
    const raw = await request.text();
    if (raw.length > MAX_PAYLOAD_BYTES) {
      throw new InfraError('VALIDATION_FAILED', `request body exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }

    let body: QueryBody;
    try {
      body = JSON.parse(raw) as QueryBody;
    } catch {
      throw new InfraError('VALIDATION_FAILED', 'request body must be JSON');
    }

    if (typeof body.sql !== 'string' || body.sql.trim() === '') {
      throw new InfraError('VALIDATION_FAILED', 'field "sql" is required');
    }
    if (body.params !== undefined && !Array.isArray(body.params)) {
      throw new InfraError('VALIDATION_FAILED', 'field "params" must be an array');
    }

    const intent = sqlIntent(body.sql);
    const caller = await requireApiKey(request, intent === 'write' ? 'db:write' : 'db:read');

    const adapter = await resolver().resolve(caller.appId);
    const result = await adapter.query({ sql: body.sql, params: body.params ?? [] });

    recordAuditAsync(db(), {
      appId: caller.appId,
      actorType: 'api_key',
      actorId: caller.key.id,
      action: 'db.query.executed',
      targetType: 'database',
      outcome: 'success',
      ipAddress: clientIp(request),
      userAgent: request.headers.get('user-agent'),
      // Shape only — never the statement text or the parameter values.
      meta: {
        sqlHash: sqlFingerprint(body.sql),
        intent,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
        provider: adapter.provider,
        requestId,
      },
    });

    return jsonOk(result.rows, requestId);
  } catch (error) {
    if (InfraError.is(error)) {
      recordAuditAsync(db(), {
        actorType: 'api_key',
        action: 'db.query.executed',
        outcome: 'failure',
        ipAddress: clientIp(request),
        meta: { code: error.code, durationMs: Date.now() - started, requestId },
      });
    }
    return toErrorResponse(error, requestId);
  }
}
