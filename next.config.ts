import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/@img/**/*",
      "./node_modules/sharp/**/*",
      "./public/**/*",
    ],
  },
  serverExternalPackages: [
    "sharp",
    "@img/sharp-linux-x64",
    "@img/sharp-libvips-linux-x64",
  ],
};

export default nextConfig;

