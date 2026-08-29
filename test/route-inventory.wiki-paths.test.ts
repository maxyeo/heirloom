import { describe, expect, it } from "vitest";

import { wikiPathExpressionsOfSource } from "@/test/route-inventory";

/**
 * `wikiPathExpressions` against literal fixtures, for the reason
 * `test/route-inventory.boundary-usage.test.ts` and
 * `test/route-inventory.schema-access.test.ts` both give: the repository is
 * the thing the guard keeps clean, so once `lib/wiki-paths.call-sites.test.ts`
 * is green every branch that *finds* something is unreachable from the real
 * tree. A checker whose job is to catch a spelling nobody has written yet
 * would otherwise be tested only by its own silence.
 *
 * The must-not-fire cases matter as much as the others and are checked as
 * deliberately. A guard that reports `app/tree/actions.ts`'s English sentence
 * about opening `/wiki/<slug>` is a guard somebody deletes rather than fixes.
 */

/** What the checker reports, flattened to the two fields under test. */
function scan(source: string, fileName = "fixture.ts") {
  return wikiPathExpressionsOfSource(source, fileName);
}

describe("template literals", () => {
  it("finds one that opens with the prefix", () => {
    expect(scan("const href = `/wiki/${slug}`;")).toEqual([
      { text: "`/wiki/${…}`", callee: null },
    ]);
  });

  it("keeps the segments around each substitution", () => {
    expect(scan("const href = `/wiki/${slug}/history/${id}/restore`;")).toEqual(
      [{ text: "`/wiki/${…}/history/${…}/restore`", callee: null }],
    );
  });

  it("finds every one, in source order", () => {
    const found = scan(
      "const a = `/wiki/${slug}`;\nconst b = `/wiki/${slug}/history`;",
    );

    expect(found.map(({ text }) => text)).toEqual([
      "`/wiki/${…}`",
      "`/wiki/${…}/history`",
    ]);
  });

  it("ignores one with nothing interpolated", () => {
    // A constant address. `"/wiki/new"` is a real href in this app and there
    // is nothing in it to encode.
    expect(scan("const href = `/wiki/new`;")).toEqual([]);
    expect(scan('const href = "/wiki/category";')).toEqual([]);
  });

  it("ignores prose that merely contains the prefix", () => {
    // `app/tree/actions.ts` really does say this to a member. It is a
    // sentence, not an href, and reporting it would buy an exemption that
    // nobody could later tell from a real one.
    const source =
      "const message = `A retired entry, ${title}, already has that " +
      "address. Open /wiki/${slug} to restore it.`;";

    expect(scan(source)).toEqual([]);
  });

  it("ignores a longer path that only starts like the prefix", () => {
    expect(scan("const href = `/wikitext/${slug}`;")).toEqual([]);
  });

  it("does not see an address built from a variable", () => {
    // The documented blind spot, pinned so that it is a known limit rather
    // than a surprise. Closing it would mean resolving what `base` holds,
    // which is a type checker rather than a scanner.
    expect(scan("const href = `${base}/history`;")).toEqual([]);
  });
});

describe("concatenation", () => {
  it("finds one whose left end is the prefix", () => {
    expect(scan('const href = "/wiki/" + slug;')).toEqual([
      { text: '"/wiki/" + ${…}', callee: null },
    ]);
  });

  it("reports a chain once", () => {
    // `"/wiki/" + a + b` parses as `("/wiki/" + a) + b`, so a naive walk
    // reports the outer node and the inner one as two addresses.
    expect(scan('const href = "/wiki/" + slug + "/history";')).toHaveLength(1);
  });

  it("finds one nested inside a concatenation that is not an address", () => {
    const found = scan('const message = "See " + ("/wiki/" + slug);');

    expect(found).toEqual([{ text: '"/wiki/" + ${…}', callee: null }]);
  });

  it("ignores a chain that merely contains the prefix further along", () => {
    expect(scan('const message = "See " + "/wiki/" + slug;')).toEqual([]);
  });

  it("reads a substitution-free template as its left end", () => {
    expect(scan("const href = `/wiki/` + slug;")).toEqual([
      { text: '"/wiki/" + ${…}', callee: null },
    ]);
  });
});

describe("the call it sits in", () => {
  it("names a plain function", () => {
    expect(scan("revalidatePath(`/wiki/${slug}/history`);")).toEqual([
      { text: "`/wiki/${…}/history`", callee: "revalidatePath" },
    ]);
  });

  it("names a method by its property, not its receiver", () => {
    // `router.push` reports `push`. The receiver is a local name that says
    // nothing about what is being called, and the assertion that consumes
    // this cares only about `revalidatePath`.
    expect(scan("router.push(`/wiki/${slug}`);")).toEqual([
      { text: "`/wiki/${…}`", callee: "push" },
    ]);
  });

  it("reports null where the address is not an argument", () => {
    expect(scan("const href = `/wiki/${slug}`;")[0].callee).toBeNull();
  });

  it("reports null for an address nested inside an argument", () => {
    // Only a *direct* argument is attributed. Something buried in an object
    // literal passed to `revalidatePath` is not the shape that call takes,
    // and inheriting the exemption down an arbitrary subtree is how an
    // exemption stops meaning what it says.
    const found = scan("revalidatePath({ path: `/wiki/${slug}` });");

    expect(found).toEqual([{ text: "`/wiki/${…}`", callee: null }]);
  });
});

describe("parsing", () => {
  it("reads JSX", () => {
    // `.tsx` picks `ts.ScriptKind.TSX`, and a TSX file parsed as plain
    // TypeScript is a syntax-error tree this would find nothing in — which
    // would be a silent green over every `Link` in the app.
    const source =
      "export const A = () => <Link href={`/wiki/${slug}/history`}>x</Link>;";

    expect(scan(source, "fixture.tsx")).toEqual([
      { text: "`/wiki/${…}/history`", callee: null },
    ]);
  });

  it("does not count a commented-out address", () => {
    // The distinction between a guard and a tripwire, as
    // `app/auth-boundary.test.ts` puts it: a regex counts a comment, and the
    // compiler's scanner does not.
    expect(scan("// const href = `/wiki/${slug}`;")).toEqual([]);
  });
});
