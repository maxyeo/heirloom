import { describe, expect, it } from "vitest";

import { formatPersonName } from "@/lib/person-format";

describe("formatPersonName", () => {
  it("joins the two halves of a name", () => {
    expect(formatPersonName("Thomas", "Hale")).toBe("Thomas Hale");
  });

  it("leaves no trailing space when the surname is unknown", () => {
    // `individuals.surname` is nullable because for the oldest generations it
    // routinely is unknown. A trailing space is invisible in a mockup and
    // very visible in a `truncate`d node.
    expect(formatPersonName("Alice", null)).toBe("Alice");
    expect(formatPersonName("Alice", "")).toBe("Alice");
  });
});
