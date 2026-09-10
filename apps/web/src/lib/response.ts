import { randomUUID } from 'node:crypto';
import { InfraError, httpStatusFor, type InfraErrorCode } from '@infra/core';

/** Every API response carries a request id so a child app can quote it in a bug report. */
export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function jsonOk<T>(data: T, requestId: string, init: ResponseInit = {}): Response {
  return Response.json(
    { data },
    { ...init, headers: { ...(init.headers ?? {}), 'x-request-id': requestId } },
  );
}

export function jsonError(
  code: InfraErrorCode,
  message: string,
  requestId: string,
  status?: number,
): Response {
  return Response.json(
    { error: { code, message, requestId } },
    { status: status ?? httpStatusFor(code), headers: { 'x-request-id': requestId } },
  );
}

/**
 * Converts anything thrown by the stack into a safe response.
 * An unexpected error is never echoed to the caller — only its request id.
 */
export function toErrorResponse(error: unknown, requestId: string): Response {
  if (InfraError.is(error)) {
    return jsonError(error.code, error.message, requestId, error.httpStatus);
  }
  console.error(`[${requestId}] unhandled error`, error);
  return jsonError('INTERNAL', 'internal server error', requestId, 500);
}
