import { describe, expect, it } from "vitest";

import { boundaryUsageOfSource } from "@/test/route-inventory";

/**
 * `boundaryUsage`, against fixtures (E10-T2, `YEO-66`).
 *
 * `app/auth-boundary.test.ts` runs this checker over every route in the app,
 * which proves it says "guarded" about files that are. It cannot prove much
 * about the shapes no route currently uses — and two of those exist only to
 * *prevent a false failure*, so a bug in them would surface as a red suite
 * blaming a page that is perfectly fine, which is the kind of failure people
 * fix by loosening the test.
 *
 * The other direction matters more. Each `shadowed` case below was a false
 * *green* at some point while this was being written: the checker said
 * "guarded" about a page that never reaches `@/lib/session`. Those are the
 * regressions worth a fixture, because nothing in the real tree would catch
 * one coming back.
 */

const GUARDED = `
import { requireSession } from "@/lib/session";
export default async function Page() {
  await requireSession();
}
`;

describe("a guard the checker must accept", () => {
  it("a plain named import and call", () => {
    expect(boundaryUsageOfSource(GUARDED)).toEqual({
      imported: true,
      called: ["requireSession"],
      shadowed: [],
    });
  });

  it("the route-handler flavour", () => {
    const source = `
      import { requireSessionOr401 } from "@/lib/session";
      export async function GET() {
        const { response } = await requireSessionOr401();
        return response ?? Response.json({});
      }
    `;
    expect(boundaryUsageOfSource(source)).toEqual({
      imported: true,
      called: ["requireSessionOr401"],
      shadowed: [],
    });
  });

  /**
   * No route aliases the guard today. If one ever does, it must not be
   * reported unguarded — a failure saying "this page does not call the
   * boundary" about a page that plainly does is the sort of thing that gets
   * the assertion deleted rather than the code fixed.
   */
  it("an aliased import, reported under its canonical name", () => {
    const source = `
      import { requireSession as guard } from "@/lib/session";
      export default async function Page() {
        await guard();
      }
    `;
    expect(boundaryUsageOfSource(source)).toEqual({
      imported: true,
      called: ["requireSession"],
      shadowed: [],
    });
  });

  it("a namespace import", () => {
    const source = `
      import * as session from "@/lib/session";
      export default async function Page() {
        await session.requireSession();
      }
    `;
    expect(boundaryUsageOfSource(source)).toEqual({
      imported: true,
      called: ["requireSession"],
      shadowed: [],
    });
  });

  it("a guard called from inside a cache() loader, as the real routes do", () => {
    const source = `
      import { cache } from "react";
      import { requireSession } from "@/lib/session";
      const load = cache(async (slug: string) => {
        await requireSession();
        return slug;
      });
      export default async function Page() {
        return load("x");
      }
    `;
    expect(boundaryUsageOfSource(source).called).toEqual(["requireSession"]);
  });
});

describe("a guard the checker must not be fooled by", () => {
  /**
   * The first false green this checker had, back when it was a regex. It is
   * exactly what a half-finished edit leaves behind.
   */
  it("a call that is commented out", () => {
    const source = `
      import { requireSession } from "@/lib/session";
      export default async function Page() {
        // await requireSession();
      }
    `;
    expect(boundaryUsageOfSource(source)).toEqual({
      imported: true,
      called: [],
      shadowed: [],
    });
  });

  it("the guard named only in a docblock", () => {
    const source = `
      /** requireSession() lives in the loader above rather than here. */
      import { requireSession } from "@/lib/session";
      export default async function Page() {}
    `;
    expect(boundaryUsageOfSource(source).called).toEqual([]);
  });

  /**
   * The false green the code review caught. Both halves look right — the
   * import is there, a call to `requireSession` is there — and the boundary
   * is never reached, because the local declaration shadows the import at
   * every call site below it.
   */
  it("a local function shadowing the import", () => {
    const source = `
      import { requireSession } from "@/lib/session";
      export default async function Page() {
        async function requireSession() {}
        await requireSession();
      }
    `;
    const usage = boundaryUsageOfSource(source);
    expect(usage.shadowed).toEqual(["requireSession"]);
  });

  it.each([
    ["a const", `const requireSession = async () => {};`],
    ["a class", `class requireSession {}`],
    [
      "a parameter",
      `function f(requireSession: () => void) { return requireSession; }`,
    ],
    ["a destructured binding", `const { requireSession } = deps;`],
  ])("%s wearing the guard's name", (_label, declaration) => {
    const source = `
      import { requireSession } from "@/lib/session";
      declare const deps: { requireSession: () => void };
      ${declaration}
      export default async function Page() {
        await requireSession();
      }
    `;
    expect(boundaryUsageOfSource(source).shadowed).toContain("requireSession");
  });

  it("the guard's name imported from somewhere that is not the boundary", () => {
    const source = `
      import { requireSession } from "@/lib/site";
      export default async function Page() {
        await requireSession();
      }
    `;
    const usage = boundaryUsageOfSource(source);
    expect(usage.imported).toBe(false);
    expect(usage.shadowed).toEqual(["requireSession"]);
  });

  it("a namespace import of some other module", () => {
    // `site.requireSession()` is not the boundary, whatever it is.
    const source = `
      import * as site from "@/lib/site";
      export default async function Page() {
        await site.requireSession();
      }
    `;
    expect(boundaryUsageOfSource(source)).toEqual({
      imported: false,
      called: [],
      shadowed: [],
    });
  });

  it("nothing at all", () => {
    expect(boundaryUsageOfSource(`export default function Page() {}`)).toEqual({
      imported: false,
      called: [],
      shadowed: [],
    });
  });
});
