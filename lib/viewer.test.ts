import { describe, expect, it } from "vitest";

import { viewerInitials, viewerLabel } from "@/lib/viewer";

describe("viewerLabel", () => {
  it("prefers the display name", () => {
    expect(viewerLabel("Rose Bennett", "rose@example.com")).toBe(
      "Rose Bennett",
    );
  });

  it("falls back to the local part of the email", () => {
    // A header is not the place for a full address, and the whole thing is one
    // click away inside the menu.
    expect(viewerLabel(null, "rose.bennett@example.com")).toBe("rose.bennett");
  });

  it("treats a blank name as no name", () => {
    // Google hands over `""` often enough that a header reading as an empty
    // gap is a real state rather than a hypothetical one.
    expect(viewerLabel("   ", "rose@example.com")).toBe("rose");
  });

  it("says something neutral when the session has neither", () => {
    expect(viewerLabel(undefined, undefined)).toBe("Account");
  });
});

describe("viewerInitials", () => {
  it("takes the first and last of a full name", () => {
    expect(viewerInitials("Rose Bennett", null)).toBe("RB");
  });

  it("skips the middle names", () => {
    expect(viewerInitials("Rose Eleanor Bennett", null)).toBe("RB");
  });

  it("gives one letter for a single word", () => {
    expect(viewerInitials("Rose", null)).toBe("R");
  });

  it("reads a dotted email local part as two words", () => {
    expect(viewerInitials(null, "rose.bennett@example.com")).toBe("RB");
  });

  it("uppercases, because a lowercase disc looks like a bug", () => {
    expect(viewerInitials(null, "rose@example.com")).toBe("R");
  });

  it("has something to show for a session with no name and no email", () => {
    expect(viewerInitials(null, null)).toBe("A");
  });
});
