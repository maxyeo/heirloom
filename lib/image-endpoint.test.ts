import { describe, expect, it } from "vitest";

import {
  IMAGE_UPLOAD_ENDPOINT,
  IMAGE_UPLOAD_FIELD,
  MAX_UPLOAD_BYTES,
  uploadErrorMessage,
  uploadedImageFrom,
} from "@/lib/image-endpoint";
import { IMAGE_ROUTE, imagePath, newImageKey } from "@/lib/storage-key";

/**
 * The wire between the editor's image button and the upload endpoint (E5-T3,
 * `YEO-43`).
 *
 * The failure this file exists for is the one `lib/import-endpoint.ts` names:
 * a disagreement between the two ends "is not a type error, it is a shape that
 * typechecks on both sides and is wrong in the middle". `app/api/images/
 * route.ts` annotates its answer with {@link UploadedImage}, so a renamed
 * field fails the build; what the compiler cannot see is JSON arriving off the
 * network, which is what the parser below is for.
 */

describe("where the button posts", () => {
  it("is the route that resolves the key back", () => {
    // One endpoint with two halves. A second spelling of the path is a second
    // thing to move when it moves.
    expect(IMAGE_UPLOAD_ENDPOINT).toBe(IMAGE_ROUTE);
  });

  it("names the field the handler reads", () => {
    expect(IMAGE_UPLOAD_FIELD).toBe("file");
  });

  it("caps uploads under the platform's request limit", () => {
    // Not a preference: a Vercel function receives at most a 4.5 MB body, and
    // the headroom is multipart framing. See the docblock.
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1000 * 1000);
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("reading a successful answer", () => {
  it("takes the three fields the handler sends", () => {
    // Built the way the handler builds it, so the assertion is about the
    // parser rather than about a literal somebody typed twice.
    const key = newImageKey("image/jpeg");
    const body = { key, path: imagePath(key), contentType: "image/jpeg" };

    expect(uploadedImageFrom(body)).toEqual(body);
  });

  it("ignores anything else in the body", () => {
    const body = {
      key: "images/ab/x.jpg",
      path: "/api/images/ab/x.jpg",
      contentType: "image/jpeg",
      url: "https://blob.example/signed?token=…",
    };

    // Notably a `url`. E5-T2 does not send one and must not start; a client
    // that quietly picked one up would be persisting a credential with a
    // fifteen-minute timer on it into an append-only revision.
    expect(uploadedImageFrom(body)).toEqual({
      key: body.key,
      path: body.path,
      contentType: body.contentType,
    });
  });

  it.each([
    ["null", null],
    ["a string", '"ok"'],
    ["an array", []],
    ["a missing path", { key: "images/ab/x.jpg", contentType: "image/jpeg" }],
    [
      "an empty path",
      { key: "images/ab/x.jpg", path: "", contentType: "image/jpeg" },
    ],
    [
      "a path that is not a string",
      { key: "images/ab/x.jpg", path: 7, contentType: "image/jpeg" },
    ],
  ])("refuses %s", (_label, body) => {
    // The failure being prevented is `<img src="undefined">` written into a
    // revision that is append-only and can never be edited back.
    expect(uploadedImageFrom(body)).toBeNull();
  });
});

describe("what the author is told when it fails", () => {
  it("uses the endpoint's own sentence", () => {
    // `lib/image-upload.ts` writes and tests these. Mapping the status onto a
    // second vocabulary here would give the same refusal two wordings.
    expect(
      uploadErrorMessage(413, { error: "Images must be 4 MB or smaller." }),
    ).toBe("Images must be 4 MB or smaller.");
    expect(
      uploadErrorMessage(415, {
        error: "Images must be one of: image/jpeg, image/png.",
      }),
    ).toBe("Images must be one of: image/jpeg, image/png.");
  });

  it("says what to do about an expired session", () => {
    // `requireSessionOr401` answers the bare string `Unauthorized`, which
    // arrives here as no JSON at all. The useful thing to say is not "401".
    expect(uploadErrorMessage(401, undefined)).toContain("Sign in again");
  });

  it("does not show a reader a status code", () => {
    // A 502, or an HTML error page from a proxy. One sentence that is true of
    // all of them.
    const message = uploadErrorMessage(502, undefined);
    expect(message).not.toMatch(/\d/);
    expect(message).toMatch(/try again/i);
  });

  it("still answers a 413 with no body, which the platform's edge sends", () => {
    // The one refusal this application's code never sees: a body over the
    // host's own request limit is rejected before the handler runs.
    expect(uploadErrorMessage(413, undefined)).toBe("That file is too large.");
  });
});
