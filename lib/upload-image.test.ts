import { describe, expect, it } from "vitest";

import { IMAGE_ROUTE } from "@/lib/storage-key";
import { uploadImage } from "@/lib/upload-image";

/**
 * The browser's half of `POST /api/images`, checked against a stub `fetch`
 * rather than a server (E5-T4, `YEO-44`). `npm test` has no server, and
 * `uploadImage` takes `fetch` as a parameter for exactly this reason — see
 * docs/testing.md, "take it, do not import it". Nothing here is mocked:
 * `fetchImpl` is a plain function this file wrote, and everything on this
 * side of it is real.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("what it sends", () => {
  it("POSTs to the image route", async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = init?.method;
      return jsonResponse(201, {
        key: "images/ab/x.jpg",
        path: "/api/images/ab/x.jpg",
        contentType: "image/jpeg",
      });
    }) as typeof fetch;

    await uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl);

    expect(requestedUrl).toBe(IMAGE_ROUTE);
    expect(requestedMethod).toBe("POST");
  });

  it("sends the blob as FormData under the field name 'file'", async () => {
    let sentBody: unknown;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sentBody = init?.body;
      return jsonResponse(201, {
        key: "images/ab/x.jpg",
        path: "/api/images/ab/x.jpg",
        contentType: "image/jpeg",
      });
    }) as typeof fetch;

    const blob = new Blob(["x"], { type: "image/jpeg" });
    await uploadImage(blob, "photo.jpg", fetchImpl);

    expect(sentBody).toBeInstanceOf(FormData);
    const form = sentBody as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect((form.get("file") as File).name).toBe("photo.jpg");
  });
});

describe("on success", () => {
  it("returns the key, path and content type on 201", async () => {
    const fetchImpl = (async () =>
      jsonResponse(201, {
        key: "images/ab/x.jpg",
        path: "/api/images/ab/x.jpg",
        contentType: "image/jpeg",
      })) as typeof fetch;

    const result = await uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl);

    expect(result).toEqual({
      ok: true,
      image: {
        key: "images/ab/x.jpg",
        path: "/api/images/ab/x.jpg",
        contentType: "image/jpeg",
      },
    });
  });

  it("reports failure rather than a half-read success when 'key' is missing", async () => {
    const fetchImpl = (async () =>
      jsonResponse(201, {
        path: "/api/images/ab/x.jpg",
        contentType: "image/jpeg",
      })) as typeof fetch;

    const result = await uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl);

    expect(result.ok).toBe(false);
  });
});

describe("on failure", () => {
  it("surfaces the endpoint's own error sentence on a 4xx", async () => {
    const fetchImpl = (async () =>
      jsonResponse(413, { error: "That file is too large." })) as typeof fetch;

    const result = await uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl);

    expect(result).toEqual({ ok: false, message: "That file is too large." });
  });

  it("falls back to a readable message on a 4xx with a non-JSON body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Not found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;

    const result = await uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain("<html>");
  });

  it("returns a readable message on a rejected fetch, without throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    await expect(
      uploadImage(new Blob(["x"]), "photo.jpg", fetchImpl),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/connection/i),
    });
  });
});
