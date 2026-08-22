import { config } from "dotenv";

/**
 * Next.js loads `.env.local` on its own, but standalone tooling — drizzle-kit
 * and any `tsx` script — does not, and `dotenv/config` only reads `.env`.
 * Load `.env.local` first; dotenv never overwrites an already-set variable, so
 * `.env` acts as a fallback and real environment variables win over both.
 */
config({ path: ".env.local", quiet: true });
config({ quiet: true });
