import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker runtime image.
  output: "standalone",
  poweredByHeader: false,
  // The floating Next.js dev-tools badge never ships in production
  // builds; disabling it in development too keeps every screen clean.
  // To bring it back locally: devIndicators: { position: "bottom-right" }
  devIndicators: false,
  experimental: {
    serverActions: {
      // The Uptime Kuma importer uploads a `kuma.db` through a server
      // action, and the default limit is 1MB. Set above the importer's
      // own 64MB ceiling on purpose: the framework rejecting the body
      // produces an error with no advice in it, where the action's
      // check produces a sentence that says what to do about a database
      // full of heartbeat history.
      bodySizeLimit: "80mb",
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
