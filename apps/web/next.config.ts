import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Keep the LibSQL driver out of the bundler and let Node require it at runtime.
   *
   * `libsql` ships one prebuilt `.node` binary per platform and picks between them with a chain of
   * `require('@libsql/darwin-arm64')`, `require('@libsql/linux-x64-gnu')` and so on. A bundler that
   * follows those calls tries to *parse* a native binary and fails with `Module parse failed:
   * Unexpected character`. Which branch it trips over depends on the machine: only the binary for
   * the current platform is installed, so the same repository builds on Linux and fails on an
   * Apple-silicon Mac — the failure travels with the developer, not with the code.
   *
   * Next 16.3.4 already lists both packages in its own default externals, so on this exact version
   * this setting changes nothing. It is written down anyway: the requirement belongs to this
   * project, not to whatever Next happens to default to next release.
   */
  serverExternalPackages: ['@libsql/client', 'libsql'],

  async rewrites() {
    return [
      // Next.js does not route directories that start with a dot, so the standards-mandated
      // path is served by an ordinary route handler behind a rewrite.
      { source: '/.well-known/jwks.json', destination: '/api/jwks' },
    ];
  },
};

export default nextConfig;
