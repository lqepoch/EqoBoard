/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    // No native UI imports next/image. Keep the Next optimizer off if one is added later.
    unoptimized: true,
  },
  outputFileTracingExcludes: {
    "/*": [
      "./node_modules/sharp/**/*",
      "./node_modules/@img/sharp-*/**/*",
      "./node_modules/lightningcss/**/*",
      "./node_modules/lightningcss-*/**/*",
    ],
  },
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};
export default nextConfig;
