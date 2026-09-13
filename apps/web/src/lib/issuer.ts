/** The `iss` every token carries. Child apps pin this when they verify offline. */
export function tokenIssuer(): string {
  const url = process.env['INFRA_PUBLIC_URL'] ?? process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}
