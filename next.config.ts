import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained server bundle, so anyone who would rather not
  // deploy to Vercel can run this in Docker or on a plain Node host without
  // touching the build config.
  //
  // Vercel is the exception: its builder emits its own output format and the
  // standalone tracing step fails there, so the setting is dropped when
  // `VERCEL` is present in the build environment. Nothing is lost — Vercel
  // never runs the standalone server.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
};

export default nextConfig;
