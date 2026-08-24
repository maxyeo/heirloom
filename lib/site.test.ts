import { afterEach, describe, expect, it } from "vitest";

import { articleTagline, siteName } from "@/lib/site";

const original = process.env.NEXT_PUBLIC_SITE_TITLE;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_TITLE;
  else process.env.NEXT_PUBLIC_SITE_TITLE = original;
});

describe("siteName", () => {
  it("falls back to Heirloom when the install has not been renamed", () => {
    delete process.env.NEXT_PUBLIC_SITE_TITLE;
    expect(siteName()).toBe("Heirloom");
  });

  it("uses the configured name", () => {
    process.env.NEXT_PUBLIC_SITE_TITLE = "The Bennetts";
    expect(siteName()).toBe("The Bennetts");
  });
});

describe("articleTagline", () => {
  it("reads the way Wikipedia's does, with this wiki's name in it", () => {
    process.env.NEXT_PUBLIC_SITE_TITLE = "The Bennetts";
    expect(articleTagline()).toBe("From The Bennetts, the family wiki");
  });
});
