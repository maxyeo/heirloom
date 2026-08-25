import { describe, expect, it } from "vitest";

import { type Dimensions, scaledTo, shouldReencode } from "@/lib/image-scale";

/**
 * The arithmetic behind a portrait's downscale, checked with no canvas in
 * sight (E5-T4, `YEO-44`). `lib/image-scale.ts`'s own docblock explains why
 * this is the half that can be tested at all: the three DOM calls around it
 * cannot run under `npm test`, but the decisions can, and they are the part
 * that is ever wrong.
 */

describe("scaledTo", () => {
  it.each<{ name: string; source: Dimensions; maxEdge: number }>([
    {
      name: "a square already inside the box",
      source: { width: 100, height: 100 },
      maxEdge: 1600,
    },
    {
      name: "a rectangle already inside the box",
      source: { width: 200, height: 50 },
      maxEdge: 1600,
    },
    {
      name: "exactly at the cap",
      source: { width: 1600, height: 900 },
      maxEdge: 1600,
    },
  ])("never upscales — $name comes back unchanged", ({ source, maxEdge }) => {
    expect(scaledTo(source, maxEdge)).toEqual(source);
  });

  it("caps the longest edge and preserves aspect ratio", () => {
    const result = scaledTo({ width: 4000, height: 2000 }, 1600);
    expect(result).toEqual({ width: 1600, height: 800 });
  });

  it("caps the longest edge whichever side it is on", () => {
    const result = scaledTo({ width: 2000, height: 4000 }, 1600);
    expect(result).toEqual({ width: 800, height: 1600 });
  });

  it("preserves aspect ratio within a pixel for a source that does not divide evenly", () => {
    const source = { width: 4001, height: 3000 };
    const result = scaledTo(source, 1600);
    expect(result).not.toBeNull();
    if (result === null) return;

    expect(Math.max(result.width, result.height)).toBe(1600);
    const expectedShort = (3000 / 4001) * 1600;
    expect(Math.abs(result.height - expectedShort)).toBeLessThanOrEqual(1);
  });

  it("keeps the short edge at least one pixel for an extreme aspect ratio", () => {
    // A 4000x1 strip scaled to fit inside 100 would ask for a height of
    // 0.025 — zero once rounded, which is a canvas dimension that throws.
    const result = scaledTo({ width: 4000, height: 1 }, 100);
    expect(result).toEqual({ width: 100, height: 1 });
  });

  it.each<{ name: string; source: Dimensions; maxEdge: number }>([
    { name: "zero width", source: { width: 0, height: 100 }, maxEdge: 1600 },
    { name: "zero height", source: { width: 100, height: 0 }, maxEdge: 1600 },
    {
      name: "negative width",
      source: { width: -1, height: 100 },
      maxEdge: 1600,
    },
    {
      name: "negative height",
      source: { width: 100, height: -1 },
      maxEdge: 1600,
    },
    { name: "NaN width", source: { width: NaN, height: 100 }, maxEdge: 1600 },
    { name: "NaN height", source: { width: 100, height: NaN }, maxEdge: 1600 },
    {
      name: "infinite width",
      source: { width: Infinity, height: 100 },
      maxEdge: 1600,
    },
    {
      name: "infinite height",
      source: { width: 100, height: Infinity },
      maxEdge: 1600,
    },
    { name: "a zero maxEdge", source: { width: 100, height: 100 }, maxEdge: 0 },
    {
      name: "a negative maxEdge",
      source: { width: 100, height: 100 },
      maxEdge: -1,
    },
  ])("returns null for $name", ({ source, maxEdge }) => {
    expect(scaledTo(source, maxEdge)).toBeNull();
  });
});

describe("shouldReencode", () => {
  const MAX_EDGE = 1600;
  const MAX_BYTES = 4 * 1024 * 1024;

  it("is true on bytes alone — small dimensions, huge file", () => {
    expect(
      shouldReencode(
        { width: 100, height: 100 },
        MAX_BYTES + 1,
        MAX_EDGE,
        MAX_BYTES,
      ),
    ).toBe(true);
  });

  it("is true on dimensions alone — under the byte cap", () => {
    expect(
      shouldReencode({ width: 3000, height: 2000 }, 1024, MAX_EDGE, MAX_BYTES),
    ).toBe(true);
  });

  it("is false when under both caps", () => {
    expect(
      shouldReencode({ width: 800, height: 600 }, 1024, MAX_EDGE, MAX_BYTES),
    ).toBe(false);
  });

  it("does not throw on a degenerate size, and reads it as not needing a resize", () => {
    // Only the byte check can still fire for a decoder's nonsense output —
    // there is no honest "too big" answer for a size that is not a size.
    expect(() =>
      shouldReencode({ width: NaN, height: NaN }, 1024, MAX_EDGE, MAX_BYTES),
    ).not.toThrow();
    expect(
      shouldReencode({ width: NaN, height: NaN }, 1024, MAX_EDGE, MAX_BYTES),
    ).toBe(false);
    expect(
      shouldReencode(
        { width: NaN, height: NaN },
        MAX_BYTES + 1,
        MAX_EDGE,
        MAX_BYTES,
      ),
    ).toBe(true);
  });
});
