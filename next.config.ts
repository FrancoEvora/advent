import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async redirects() {
    return [
      {
        // Fail closed for the public hostname if it is accidentally associated
        // with this private application. Do not serve any ERP route on it.
        // Temporary until the domain is moved to the institutional project.
        source: "/:path*",
        has: [{ type: "host", value: "evora\\.terraragroup\\.com\\.br" }],
        destination: "https://evora-institucional.vercel.app/",
        permanent: false,
      },
      {
        // The institutional site is a separate Vercel project, not an ERP route.
        // Preserve old shared links without serving institutional code here.
        source: "/evora/:path*",
        destination: "https://evora-institucional.vercel.app/",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      ...["/cliente/:path*", "/proposta/:path*", "/contrato/:path*", "/parceiro/:path*", "/atendimento/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      })),
    ];
  },
};

export default nextConfig;
