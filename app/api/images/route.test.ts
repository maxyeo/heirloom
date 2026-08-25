import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * The wiring of the upload endpoint (E5-T2, `YEO-42`).
 *
 * The *decisions* are tested in `lib/image-upload.test.ts` against the real
 * implementation with nothing stubbed. What is left for this file is the part
 * that only exists inside a route, and it is worth driving for real rather
 * than reading: that an anonymous caller gets a 401 before anything else
 * happens, that a multipart body is unpacked the way a browser sends one, and
 * that what comes back is a key and never a URL.
 *
 * ## The two mocks, and why they are the only two
 *
 * `@/auth` calls `NextAuth()` at import time and does not load outside the
 * Next.js runtime, which is the same reason `app/auth-boundary.test.ts` gives
 * for stubbing it and stubbing nothing else. `@/lib/storage` is the network:
 * it needs a credential and a Blob store, and what this file wants to know
 * about it is what it was *handed*, which a spy answers better than a store
 * would.
 *
 * The storage vendor's SDK is deliberately not what gets mocked, even though
 * that would leave the storage module in play. Naming the package here — in a
 * `vi.mock` specifier or, as this paragraph would have, in a sentence about
 * not using it — fails `lib/storage.call-sites.test.ts`, which grants it to
 * three files by name. The seam is the honest boundary for a route's test
 * anyway.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
}));
vi.mock("@/auth", () => ({ auth: async () => state.session }));

const storage = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/storage", () => storage);

const { POST } = await import("@/app/api/images/route");

const SIGNED_URL =
  "https://abc123.private.blob.vercel-storage.com/images/ab/x.jpg?signature=sig";

const photograph = () =>
  jpeg([
    app1Exif(
      tiff({ ifd0: [shortField(TAG.orientation, 6)], gps: gpsFields() }),
    ),
  ]);

/** A POST shaped exactly as a browser's `fetch` with a `FormData` body sends it. */
function upload(
  body: Uint8Array<ArrayBuffer>,
  { field = "file", filename = "IMG_4021.JPG", type = "image/jpeg" } = {},
): Request {
  const form = new FormData();
  form.set(field, new File([body], filename, { type }));
  return new Request("http://localhost/api/images", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  storage.put.mockReset();
  storage.put.mockImplementation(async (key: string) => ({
    key,
    url: SIGNED_URL,
    contentType: "image/jpeg",
  }));
});

describe("the guard", () => {
  it("answers 401 to a caller with no session", async () => {
    state.session = null;
    const response = await POST(upload(photograph()));

    expect(response.status).toBe(401);
    // And nothing was stored on the way to finding that out.
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("a successful upload", () => {
  it("returns a key and a site-relative path, and no URL at all", async () => {
    const response = await POST(upload(photograph()));
    expect(response.status).toBe(201);

    const body = await response.json();
    // The whole point of `YEO-86`: the URL `put` returned expires in fifteen
    // minutes, so handing it to a caller who might persist it is the mistake
    // this endpoint exists to make impossible.
    expect(Object.keys(body).sort()).toEqual(["contentType", "key", "path"]);
    expect(JSON.stringify(body)).not.toContain("blob.vercel-storage.com");

    expect(body.key).toMatch(/^images\/[0-9a-f]{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(body.path).toBe(`/api/images/${body.key.slice("images/".length)}`);
    expect(body.contentType).toBe("image/jpeg");
  });

  it("stores the scrubbed bytes, not the ones it was sent", async () => {
    await POST(upload(photograph()));

    const [, stored] = storage.put.mock.calls[0];
    const bytes = new Uint8Array(await (stored as Blob).arrayBuffer());
    expect(contains(photograph(), GPS_DATE_STAMP)).toBe(true);
    expect(contains(bytes, GPS_DATE_STAMP)).toBe(false);
  });

  it("stores under the sniffed type, never the client's claim", async () => {
    await POST(upload(photograph(), { type: "text/html" }));

    const [key, , options] = storage.put.mock.calls[0];
    expect(options).toEqual({ contentType: "image/jpeg" });
    expect(key).toMatch(/\.jpg$/);
  });

  it("ignores the filename it was given", async () => {
    // Not sanitised — unused. A sanitised filename is still an
    // attacker-chosen string that survived a function somebody has to keep
    // correct, and nothing here ever shows a key to a person.
    await POST(upload(photograph(), { filename: "../../evil.php" }));

    const [key] = storage.put.mock.calls[0];
    expect(key).not.toContain("evil");
    expect(key).not.toContain("..");
  });
});

describe("what is refused", () => {
  it("answers 415 to a file that is not an image, whatever it claims", async () => {
    const html = new Uint8Array(
      [...`<!DOCTYPE html>`].map((c) => c.charCodeAt(0)),
    );
    const response = await POST(upload(html, { type: "image/png" }));

    expect(response.status).toBe(415);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("answers 400 when there is no file in the field it expects", async () => {
    const response = await POST(upload(photograph(), { field: "photo" }));
    expect(response.status).toBe(400);
  });

  it("answers 400 to a body that is not a multipart form", async () => {
    const response = await POST(
      new Request("http://localhost/api/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("answers 413 on the declared length, before reading the body", async () => {
    // `Content-Length` is the client's own claim, so it may only ever refuse.
    const request = upload(photograph());
    request.headers.set("content-length", String(64 * 1024 * 1024));

    expect((await POST(request)).status).toBe(413);
    expect(storage.put).not.toHaveBeenCalled();
  });
});
