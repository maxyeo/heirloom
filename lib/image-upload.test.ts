import { describe, expect, it } from "vitest";

import {
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  prepareUpload,
} from "@/lib/image-upload";
import {
  app1Exif,
  contains,
  gpsFields,
  GPS_DATE_STAMP,
  jpeg,
  shortField,
  TAG,
  tiff,
} from "@/test/image-fixtures";

/**
 * Every decision the upload endpoint makes, driven with nothing stubbed
 * (E5-T2, `YEO-42`).
 *
 * This is the file that covers the acceptance criteria. It can do that
 * because the decisions were deliberately kept out of the route handler,
 * which cannot be imported without mocking the module that holds the security
 * boundary — see the docblock on `lib/image-upload.ts`.
 */

const photograph = () =>
  jpeg([
    app1Exif(
      tiff({ ifd0: [shortField(TAG.orientation, 6)], gps: gpsFields() }),
    ),
  ]);

const text = (body: string) =>
  new Uint8Array([...body].map((character) => character.charCodeAt(0)));

describe("a photograph", () => {
  const prepared = prepareUpload(photograph());

  it("is accepted, with the type read off its bytes", () => {
    expect(prepared.ok).toBe(true);
    expect(prepared.ok && prepared.contentType).toBe("image/jpeg");
  });

  it("is stored under a generated key", () => {
    expect(prepared.ok && prepared.key).toMatch(/^images\/[0-9a-f]{2}\//);
  });

  it("has its location taken out on the way through", () => {
    expect(contains(photograph(), GPS_DATE_STAMP)).toBe(true);
    expect(prepared.ok && contains(prepared.body, GPS_DATE_STAMP)).toBe(false);
  });
});

describe("the size cap", () => {
  it("sits under the request body a Vercel function can receive", () => {
    // 4.5 MB is the platform's, enforced before this application's code runs,
    // and the storage vendor's own README names client-side upload as the
    // only way past it — which two tripwires in this repository forbid. So the
    // cap is not a preference and cannot be raised here.
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1000 * 1000);
    // The header check may only reject, so its threshold has to leave room
    // for the multipart framing around a file of exactly the maximum size.
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  it("accepts a file of exactly the maximum size", () => {
    const atTheLimit = new Uint8Array(MAX_UPLOAD_BYTES);
    atTheLimit.set(jpeg([]), 0);
    expect(prepareUpload(atTheLimit).ok).toBe(true);
  });

  it("refuses one byte more, with the limit in the message", () => {
    const overTheLimit = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    overTheLimit.set(jpeg([]), 0);
    const rejected = prepareUpload(overTheLimit);

    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.status).toBe(413);
    expect(!rejected.ok && rejected.message).toContain("4 MB");
  });

  it("is checked before the contents are looked at", () => {
    // An oversized file should be refused, not parsed. A 413 rather than the
    // 415 its contents would have earned is how that is visible.
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    huge.set(text("<!DOCTYPE html>"), 0);
    expect(prepareUpload(huge)).toMatchObject({ ok: false, status: 413 });
  });
});

describe("the allowlist", () => {
  it("refuses a file that is not one of the four", () => {
    const rejected = prepareUpload(
      text("<svg xmlns='http://www.w3.org/2000/svg'>"),
    );
    expect(rejected).toMatchObject({ ok: false, status: 415 });
    expect(!rejected.ok && rejected.message).toContain("image/jpeg");
  });

  it("refuses an empty file", () => {
    expect(prepareUpload(new Uint8Array())).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("a damaged image", () => {
  it("is refused rather than stored unread", () => {
    // The signature matched and the structure did not. Storing it would mean
    // storing metadata this code could not account for.
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    expect(prepareUpload(broken)).toMatchObject({ ok: false, status: 400 });
  });
});
