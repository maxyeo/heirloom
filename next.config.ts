import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained server bundle, so anyone who would rather not
  // deploy to Vercel can run this in Docker or on a plain Node host without
  // touching the build config.
  output: "standalone",
};

export default nextConfig;
