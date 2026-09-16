import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": ["./public/**/*"],
  },
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
