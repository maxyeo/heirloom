import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type Db = ReturnType<typeof create>;

function create() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  }

  /**
   * Supabase's pooler runs in transaction mode, which does not support
   * prepared statements — Drizzle fails with an opaque error without
   * `prepare: false`. The flag is harmless on any other Postgres, so it stays
   * on unconditionally rather than being made Supabase-specific.
   */
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}

// Next.js reloads modules on every edit in dev; without a singleton each
// reload opens a new pool and exhausts the connection limit.
const globalForDb = globalThis as unknown as { db?: Db };

function getDb(): Db {
  if (!globalForDb.db) globalForDb.db = create();
  return globalForDb.db;
}

/**
 * Connecting lazily rather than at import time keeps `next build` working in
 * environments with no database configured — the build imports these modules
 * to analyse routes, and an eager connection would fail it.
 */
export const db = new Proxy({} as Db, {
  get: (_target, prop, receiver) => Reflect.get(getDb(), prop, receiver),
});

export { schema };
