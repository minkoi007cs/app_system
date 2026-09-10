/**
 * Error taxonomy shared by every Unified-App-Infra package.
 * Rule: an InfraError message NEVER contains a secret, a connection string,
 * a raw API key or a query parameter value.
 */

export type InfraErrorCode =
  | 'CONFIG_INVALID'
  | 'CRYPTO_KEY_INVALID'
  | 'CRYPTO_ENCRYPT_FAILED'
  | 'CRYPTO_DECRYPT_FAILED'
  | 'API_KEY_MALFORMED'
  | 'API_KEY_INVALID'
  | 'API_KEY_REVOKED'
  | 'API_KEY_EXPIRED'
  | 'FORBIDDEN_SCOPE'
  | 'UNAUTHENTICATED'
  | 'APP_NOT_FOUND'
  | 'APP_SUSPENDED'
  | 'DB_CONFIG_MISSING'
  | 'DB_CONNECTION_FAILED'
  | 'DB_QUERY_FAILED'
  | 'DB_QUERY_TIMEOUT'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

const HTTP_STATUS: Readonly<Record<InfraErrorCode, number>> = {
  CONFIG_INVALID: 500,
  CRYPTO_KEY_INVALID: 500,
  CRYPTO_ENCRYPT_FAILED: 500,
  CRYPTO_DECRYPT_FAILED: 500,
  API_KEY_MALFORMED: 401,
  API_KEY_INVALID: 401,
  API_KEY_REVOKED: 401,
  API_KEY_EXPIRED: 401,
  FORBIDDEN_SCOPE: 403,
  UNAUTHENTICATED: 401,
  APP_NOT_FOUND: 404,
  APP_SUSPENDED: 403,
  DB_CONFIG_MISSING: 409,
  DB_CONNECTION_FAILED: 502,
  DB_QUERY_FAILED: 400,
  DB_QUERY_TIMEOUT: 504,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 422,
  INTERNAL: 500,
};

export interface InfraErrorOptions {
  cause?: unknown;
  /** Safe-to-log context only: ids, counts, durations. Never values of secrets. */
  details?: Record<string, unknown>;
  httpStatus?: number;
}

export interface SerializedInfraError {
  code: InfraErrorCode;
  message: string;
  httpStatus: number;
  details: Record<string, unknown>;
}

export class InfraError extends Error {
  readonly code: InfraErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: InfraErrorCode, message: string, options: InfraErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InfraError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? HTTP_STATUS[code];
    this.details = options.details ?? {};
  }

  toJSON(): SerializedInfraError {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      details: this.details,
    };
  }

  static is(value: unknown): value is InfraError {
    return value instanceof InfraError;
  }
}

export function httpStatusFor(code: InfraErrorCode): number {
  return HTTP_STATUS[code];
}
