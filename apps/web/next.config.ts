import type { NextConfig } from "next";

// Content-Security-Policy is set per request (with a nonce) in src/proxy.ts.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@elevate/api-client"],
  // Combined deployment (one container runs this app and the API on 127.0.0.1:8000): the public
  // API paths are forwarded to the local API, so the extension and health checks use this origin.
  async rewrites() {
    if (process.env.ELEVATE_COMBINED !== "1") return [];
    const api = "http://127.0.0.1:8000";
    return [
      { source: "/api/v1/:path*", destination: `${api}/api/v1/:path*` },
      { source: "/health/:path*", destination: `${api}/health/:path*` },
      { source: "/metrics", destination: `${api}/metrics` },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
