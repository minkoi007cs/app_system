/**
 * Per-app CORS.
 *
 * A child app may call the hub from any domain it has registered in `infra_apps.allowed_origins`
 * and nowhere else. Because every call carries a bearer token rather than a cookie,
 * `Access-Control-Allow-Credentials` is deliberately NOT set — there is nothing ambient to protect,
 * and leaving it off keeps a wildcard mistake from ever becoming a credentialed one.
 */
export const CORS_MAX_AGE_SECONDS = 600;

export function originAllowed(origin: string | null, allowedOrigins: readonly string[]): boolean {
  if (origin === null || origin === '') return false;
  return allowedOrigins.includes(origin);
}

export function corsHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  if (!originAllowed(origin, allowedOrigins)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin as string,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-infra-app',
    'access-control-max-age': String(CORS_MAX_AGE_SECONDS),
    vary: 'Origin',
  };
}

/** Answer to a preflight. Unknown origins get 403 rather than a permissive default. */
export function preflightResponse(origin: string | null, allowedOrigins: readonly string[]): Response {
  const allowed = originAllowed(origin, allowedOrigins);
  return new Response(null, {
    status: allowed ? 204 : 403,
    headers: corsHeaders(origin, allowedOrigins),
  });
}

export function withCors(response: Response, headers: Record<string, string>): Response {
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
