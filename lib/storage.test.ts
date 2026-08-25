import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as storage from "@/lib/storage";

/**
 * `@vercel/blob` is the one thing in this repository that talks to somebody
 * else's server, so it is stubbed rather than called. What is worth asserting
 * here is not that Vercel works — it is the set of decisions `lib/storage.ts`
 * makes *on the way* to Vercel, every one of which is load-bearing for the
 * portability claim and every one of which is a single option away from being
 * silently wrong:
 *
 * - the key you write is the key you read (`addRandomSuffix: false`)
 * - `put` replaces, the way every other object store's PUT does
 * - a missing object is `null`, not a vendor exception
 * - the credential comes from `STORAGE_TOKEN`, never from the SDK's own
 *   `BLOB_READ_WRITE_TOKEN` default
 *
 * `BlobNotFoundError` is declared in the factory as a real class so that the
 * module's `instanceof` check is exercised for real. A mock returning a plain
 * object with the right `name` would pass while the production code path
 * threw.
 */
const blob = vi.hoisted(() => ({
  put: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
  /**
   * Declared inside `vi.hoisted` rather than as a top-level `class`: the
   * factory below is hoisted above every declaration in this file, so a
   * class statement here would still be in its temporal dead zone when the
   * mock is built.
   */
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));

vi.mock("@vercel/blob", () => ({
  put: blob.put,
  head: blob.head,
  del: blob.del,
  BlobNotFoundError: blob.BlobNotFoundError,
}));

const KEY = "images/9f8b/portrait.jpg";
const URL =
  "https://abc123.public.blob.vercel-storage.com/images/9f8b/portrait.jpg";

beforeEach(() => {
  vi.stubEnv("STORAGE_TOKEN", "vercel_blob_rw_test_token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("the exported surface", () => {
  it("is put, get and delete, and nothing else", () => {
    // The acceptance criterion, stated as an assertion. A fourth export is
    // how a seam stops being one: `list` or `copy` or `presign` narrows the
    // set of hosts that can implement this to the ones that agree with
    // Vercel. Deleting a name from this array should require an argument.
    expect(Object.keys(storage).sort()).toEqual(["delete", "get", "put"]);
  });
});

describe("put", () => {
  it("stores under the key it was given, and returns it unchanged", async () => {
    blob.put.mockResolvedValue({
      pathname: KEY,
      url: URL,
      contentType: "image/jpeg",
      downloadUrl: `${URL}?download=1`,
      contentDisposition: "inline",
      etag: "abc",
    });

    const stored = await storage.put(KEY, "bytes", {
      contentType: "image/jpeg",
    });

    expect(stored).toEqual({ key: KEY, url: URL, contentType: "image/jpeg" });

    const [pathname, body, options] = blob.put.mock.calls[0];
    expect(pathname).toBe(KEY);
    expect(body).toBe("bytes");
    // The property `get` depends on: without this pinned off, the stored
    // pathname is something only the put response knows and `get(key)` finds
    // nothing.
    expect(options.addRandomSuffix).toBe(false);
    // PUT replaces. Vercel's SDK defaults to refusing this; S3, GCS, R2 and a
    // filesystem do not.
    expect(options.allowOverwrite).toBe(true);
    expect(options.access).toBe("public");
    expect(options.contentType).toBe("image/jpeg");
  });

  it("passes STORAGE_TOKEN explicitly rather than leaning on the SDK's own env var", async () => {
    // If the token were ever dropped from the options, the SDK would fall
    // back to BLOB_READ_WRITE_TOKEN and everything would keep working on
    // Vercel — while `.env.example` and every other host's config silently
    // stopped being the thing that configures storage.
    blob.put.mockResolvedValue({
      pathname: KEY,
      url: URL,
      contentType: "image/jpeg",
    });

    await storage.put(KEY, "bytes");

    expect(blob.put.mock.calls[0][2].token).toBe("vercel_blob_rw_test_token");
  });

  it("fails with a readable error when STORAGE_TOKEN is unset", async () => {
    vi.stubEnv("STORAGE_TOKEN", "");

    await expect(storage.put(KEY, "bytes")).rejects.toThrow(/STORAGE_TOKEN/);
    // Resolved per call, not at import time — a module-level read would have
    // failed `next build`, which runs with no environment at all.
    expect(blob.put).not.toHaveBeenCalled();
  });
});

describe("get", () => {
  it("describes what is stored", async () => {
    blob.head.mockResolvedValue({
      pathname: KEY,
      url: URL,
      contentType: "image/jpeg",
      size: 1024,
      uploadedAt: new Date(),
    });

    await expect(storage.get(KEY)).resolves.toEqual({
      key: KEY,
      url: URL,
      contentType: "image/jpeg",
    });
    expect(blob.head.mock.calls[0][1].token).toBe("vercel_blob_rw_test_token");
  });

  it("answers null for a key that is not there", async () => {
    // An ordinary answer, not an exception: an append-only revision can
    // outlive the image it references, so callers hit this legitimately and
    // must not have to catch a vendor's error class to find out.
    blob.head.mockRejectedValue(new blob.BlobNotFoundError("not found"));

    await expect(storage.get(KEY)).resolves.toBeNull();
  });

  it("lets every other failure through", async () => {
    // A bad token and a dead network are not "no such object". Flattening
    // them into null would render a missing image where an outage happened.
    blob.head.mockRejectedValue(new Error("Access denied"));

    await expect(storage.get(KEY)).rejects.toThrow("Access denied");
  });
});

describe("delete", () => {
  it("removes the key", async () => {
    blob.del.mockResolvedValue(undefined);

    await storage.delete(KEY);

    expect(blob.del).toHaveBeenCalledWith(KEY, {
      token: "vercel_blob_rw_test_token",
    });
  });

  it("is reachable as a property, which is the only way a reserved word can be", () => {
    // `import { delete }` does not parse; `storage.delete` does. This is why
    // the module documents a namespace import as the way to reach it.
    expect(typeof storage.delete).toBe("function");
  });
});
