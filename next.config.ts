import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Ticket availability, order status and admin data must be read fresh on every
  // request. Cache Components (and its `use cache` lifetimes) would let a stale
  // availability count be served from a prerendered shell, which is exactly how a
  // storefront ends up overselling, so the app stays on request-time rendering.
  cacheComponents: false,
  partialPrefetching: false,
  reactStrictMode: true,
  turbopack: {
    // tw-animate-css ships only a "style" export condition, which the CSS resolver
    // does not follow; point the bare specifier at the file it actually exports.
    resolveAlias: {
      'tw-animate-css': './node_modules/tw-animate-css/dist/tw-animate.css',
    },
  },
  images: {
    remotePatterns: [],
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Ticket PDFs are served through authenticated routes; they must never be
        // written to a shared cache or read by another origin.
        source: '/api/orders/:path*/tickets/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        source: '/api/admin/inventory/:path*/file',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
