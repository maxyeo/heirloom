import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Two projects, split on one question: does the test need Postgres?
 *
 * `npm test` runs the `unit` project only, and CI's `check` job runs `npm
 * test` in the same bare environment as `npm run build` — no DATABASE_URL, no
 * AUTH_*. Anything that needs a database therefore has to stay out of the
 * default run, or that job goes red on every commit for reasons that have
 * nothing to do with the commit. Naming a file `*.db.test.ts` is what opts it
 * out; `npm run test:db` is what runs it.
 *
 * Both projects run in CI and both gate a merge — the `db` one in a separate
 * job with a Postgres service of its own, which is what lets the bare job stay
 * bare. The split is about which environment each half may assume, not about
 * which half is checked. See docs/testing.md.
 */
export default defineConfig({
  resolve: {
    // Picks up `@/*` from tsconfig.json. The alias is declared once, there, so
    // the compiler and the test runner cannot drift apart. (Vite resolves
    // tsconfig paths natively as of Vite 8; the `vite-tsconfig-paths` plugin
    // the Next.js guide reaches for is no longer needed.)
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [
            ...defaultExclude,
            "**/.next/**",
            "**/*.db.{test,spec}.?(c|m)[jt]s?(x)",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: [...defaultExclude, "**/.next/**"],
          setupFiles: ["./test/db-setup.ts"],
          // Every file in this project talks to the same database, so running
          // them in parallel would have them clearing each other's rows
          // mid-assertion.
          fileParallelism: false,
        },
      },
    ],
  },
});
