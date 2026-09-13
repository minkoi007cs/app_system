import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Next.js does not route directories that start with a dot, so the standards-mandated
      // path is served by an ordinary route handler behind a rewrite.
      { source: '/.well-known/jwks.json', destination: '/api/jwks' },
    ];
  },
};

export default nextConfig;
