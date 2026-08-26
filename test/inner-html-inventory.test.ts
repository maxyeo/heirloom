import { describe, expect, it } from "vitest";

import { callSitesInSource } from "@/test/inner-html-inventory";

/**
 * `callSitesInSource`, against fixtures (`YEO-96`).
 *
 * `lib/sanitize-html.call-sites.test.ts` runs this checker over the whole
 * source tree, which proves it finds the call sites that are there and reads
 * the two markers that exist. It cannot prove much about the shapes no file
 * currently uses — a malformed marker, two markers on one attribute, an
 * attribute in a file that also *discusses* the attribute — and those are
 * exactly the branches that exist to stop a false green. Without fixtures they
 * would be code that only a mutation run had ever executed.
 *
 * The `.tsx` filename passed below is not decoration: it is what selects the
 * JSX script kind, and a checker that parsed a component as plain TypeScript
 * would find no call sites anywhere and report the tree clean.
 */

const FILE = "components/Fixture.tsx";

/** `callSitesInSource`, with the fixture filename supplied. */
function sites(source: string) {
  return callSitesInSource(source, FILE);
}

describe("callSitesInSource", () => {
  it("finds an attribute and reports the line it is on", () => {
    expect(
      sites(
        'export const A = () => <div dangerouslySetInnerHTML={{ __html: "" }} />;',
      ),
    ).toEqual([{ line: 1, marker: null }]);
  });

  it("finds every attribute in a file, not just the first", () => {
    const source = [
      "export const A = () => (",
      "  <>",
      "    <div dangerouslySetInnerHTML={{ __html: a }} />",
      "    <span dangerouslySetInnerHTML={{ __html: b }} />",
      "  </>",
      ");",
    ].join("\n");

    // The whole point of the ticket. One exempt call site in a file must not
    // make a second one invisible, and it cannot if they are counted apart.
    expect(sites(source)).toEqual([
      { line: 3, marker: null },
      { line: 4, marker: null },
    ]);
  });

  it("reads the marker attached to an attribute", () => {
    const source = [
      "export const A = () => (",
      "  <div",
      "    /* sanitize-html-exempt: already-sanitised */",
      "    dangerouslySetInnerHTML={{ __html: a }}",
      "  />",
      ");",
    ].join("\n");

    expect(sites(source)).toEqual([{ line: 4, marker: "already-sanitised" }]);
  });

  it("reads a marker written as a line comment", () => {
    const source = [
      "export const A = () => (",
      "  <div",
      "    // sanitize-html-exempt: already-sanitised",
      "    dangerouslySetInnerHTML={{ __html: a }}",
      "  />",
      ");",
    ].join("\n");

    expect(sites(source)).toEqual([{ line: 4, marker: "already-sanitised" }]);
  });

  it("attaches a marker to one attribute, not to the element after it", () => {
    const source = [
      "export const A = () => (",
      "  <>",
      "    <div",
      "      /* sanitize-html-exempt: already-sanitised */",
      "      dangerouslySetInnerHTML={{ __html: a }}",
      "    />",
      "    <span dangerouslySetInnerHTML={{ __html: b }} />",
      "  </>",
      ");",
    ].join("\n");

    // A marker that leaked onto the next call site would be the whole-file
    // exemption back again, wearing a comment.
    expect(sites(source)).toEqual([
      { line: 5, marker: "already-sanitised" },
      { line: 7, marker: null },
    ]);
  });

  it("does not read a marker written outside the element's own tag", () => {
    const source = [
      "export const A = () => (",
      "  <>",
      "    {/* sanitize-html-exempt: already-sanitised */}",
      "    <div dangerouslySetInnerHTML={{ __html: a }} />",
      "  </>",
      ");",
    ].join("\n");

    // A `{/* … */}` is a sibling node rather than trivia on the attribute, so
    // it does not travel with the call site — reordering two elements would
    // silently move the exemption. Refusing to read it there is what makes
    // "the marker is attached to the attribute" true rather than approximate.
    expect(sites(source)).toEqual([{ line: 4, marker: null }]);
  });

  it("counts no call site in prose that merely names the attribute", () => {
    const source = [
      "/**",
      " * Comes back out through `dangerouslySetInnerHTML`.",
      " *",
      " * @example",
      " * ```ts",
      " * <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />",
      " * ```",
      " */",
      'export const NAME = "dangerouslySetInnerHTML";',
    ].join("\n");

    // `lib/sanitize-html.ts` in miniature, and the reason its whole-file
    // exemption could be deleted rather than narrowed.
    expect(sites(source)).toEqual([]);
  });

  it("refuses a marker that names no exemption", () => {
    const source = [
      "export const A = () => (",
      "  <div",
      "    /* sanitize-html-exempt */",
      "    dangerouslySetInnerHTML={{ __html: a }}",
      "  />",
      ");",
    ].join("\n");

    // Reporting `null` here would be correct and useless: the call site would
    // fall back to being judged by whether its *file* sanitises, which is the
    // coarse answer being replaced — and it would look exempt to every human
    // who read it.
    expect(() => sites(source)).toThrow(/names no exemption/);
  });

  it("refuses two markers on one attribute", () => {
    const source = [
      "export const A = () => (",
      "  <div",
      "    /* sanitize-html-exempt: old-id */",
      "    /* sanitize-html-exempt: new-id */",
      "    dangerouslySetInnerHTML={{ __html: a }}",
      "  />",
      ");",
    ].join("\n");

    // A rename half-done. Picking one would let the stale id live forever in
    // the register, which is the thing the register exists to prevent.
    expect(() => sites(source)).toThrow(/one exemption/);
  });

  it("names the file and line when it refuses", () => {
    const source = [
      "<div",
      "  /* sanitize-html-exempt */",
      "  dangerouslySetInnerHTML={{ __html: a }}",
      "/>;",
    ].join("\n");

    // A tripwire whose failure does not say where to look gets the assertion
    // deleted rather than the call site fixed.
    expect(() => sites(source)).toThrow(`${FILE}:3`);
  });
});
