import type { NextConfig } from "next";
const config: NextConfig = { poweredByHeader: false, reactStrictMode: true, async headers() { return [{ source: "/api/forms/solaris", headers: [{ key: "Cache-Control", value: "no-store" }] }]; } };
export default config;
