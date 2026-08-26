import type { NextConfig } from "next";

const config: NextConfig = {
  // packages/core เป็น TypeScript ดิบ (ไม่ build เป็น dist) → ให้ Next transpile ให้
  transpilePackages: ["@line-crm/core"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
