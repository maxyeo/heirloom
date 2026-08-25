import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@vercel/blob` is the one thing in this repository that talks to somebody
 * else's server, so it is stubbed rather than called. What is worth asserting
 * here is not that Vercel works — it is the set of decisions `lib/storage.ts`
 * makes *on the way* to Vercel, every one of which is load-bearing and every
 * one of which is a single option away from being silently wrong:
 *
 * - the key you write is the key you read (`addRandomSuffix: false`)
 * - `put` replaces, the way every other object store's PUT does
 * - a missing object is `null`, not a vendor exception
 * - the credential comes from `STORAGE_TOKEN`, never from the SDK's own
 *   `BLOB_READ_WRITE_TOKEN` default
 * - the store is **private** and every URL expires (YEO-86)
 *
 * That last one is the one a test has to hold down, because it is the only
 * one whose failure mode is invisible: `access: "public"` would keep every
 * other assertion in this file green while putting family photographs
 * outside the `ALLOWED_EMAILS` boundary. Nothing would break. That is the
 * problem.
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
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
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
  issueSignedToken: blob.issueSignedToken,
  presignUrl: blob.presignUrl,
  BlobNotFoundError: blob.BlobNotFoundError,
}));

const KEY = "images/9f8b/portrait.jpg";
/**
 * A private store's own host. Public blobs live on `*.public.…`, so the
 * hostname is the posture; the fixture spells it out rather than reusing a
 * generic URL.
 */
const STORE_URL = `https://abc123.private.blob.vercel-storage.com/${KEY}`;
const signed = (pathname: string) =>
  `https://abc123.private.blob.vercel-storage.com/${pathname}?vercel-blob-signature=sig`;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The module keeps its delegation in a module-level variable, on purpose:
 * issuing one per URL would put a control-API round trip in front of every
 * image on a page. That cache would otherwise leak between tests and make the
 * "issued once" assertions below pass for the wrong reason, so each test gets
 * a fresh copy of the module rather than only a fresh set of mocks.
 */
let storage: typeof import("@/lib/storage");

function storedBlob(overrides: Record<string, unknown> = {}) {
  return {
    pathname: KEY,
    url: STORE_URL,
    contentType: "image/jpeg",
    downloadUrl: `${STORE_URL}?download=1`,
    contentDisposition: "inline",
    etag: "abc",
    ...overrides,
  };
}

beforeEach(async () => {
  vi.stubEnv("STORAGE_TOKEN", "vercel_blob_rw_test_token");

  blob.issueSignedToken.mockResolvedValue({
    delegationToken: "delegation-token",
    clientSigningToken: "client-signing-token",
    validUntil: Date.now() + HOUR,
  });
  blob.presignUrl.mockImplementation(
    async (_signedToken: unknown, options: { pathname: string }) => ({
      presignedUrl: signed(options.pathname),
    }),
  );

  vi.resetModules();
  storage = await import("@/lib/storage");
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
    // Vercel. Signing is why that is worth restating — it arrived as two new
    // vendor calls and stayed *inside* the module, which is the claim YEO-41
    // made and YEO-86 collected on.
    expect(Object.keys(storage).sort()).toEqual(["delete", "get", "put"]);
  });
});

describe("put", () => {
  it("stores under the key it was given, and returns it unchanged", async () => {
    blob.put.mockResolvedValue(storedBlob());

    const stored = await storage.put(KEY, "bytes", {
      contentType: "image/jpeg",
    });

    expect(stored).toEqual({
      key: KEY,
      url: signed(KEY),
      contentType: "image/jpeg",
    });

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
    expect(options.contentType).toBe("image/jpeg");
  });

  it("stores privately", async () => {
    // YEO-86, and the single most consequential option in the file. A
    // photograph written to a public store is readable by anyone who ever
    // sees its URL, for as long as it exists, with no session in the way.
    blob.put.mockResolvedValue(storedBlob());

    await storage.put(KEY, "bytes");

    expect(blob.put.mock.calls[0][2].access).toBe("private");
  });

  it("passes STORAGE_TOKEN explicitly rather than leaning on the SDK's own env var", async () => {
    // If the token were ever dropped from the options, the SDK would fall
    // back to BLOB_READ_WRITE_TOKEN and everything would keep working on
    // Vercel — while `.env.example` and every other host's config silently
    // stopped being the thing that configures storage.
    blob.put.mockResolvedValue(storedBlob());

    await storage.put(KEY, "bytes");

    expect(blob.put.mock.calls[0][2].token).toBe("vercel_blob_rw_test_token");
    expect(blob.issueSignedToken.mock.calls[0][0].token).toBe(
      "vercel_blob_rw_test_token",
    );
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
    blob.head.mockResolvedValue(storedBlob({ size: 1024 }));

    await expect(storage.get(KEY)).resolves.toEqual({
      key: KEY,
      url: signed(KEY),
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

  it("does not sign a URL for a key that is not there", async () => {
    // Signing is arithmetic over a pathname — it would cheerfully mint a
    // valid-looking URL for an image deleted last week. Checking existence
    // first is what makes `get` an answer about the object rather than about
    // the string.
    blob.head.mockRejectedValue(new blob.BlobNotFoundError("not found"));

    await storage.get(KEY);

    expect(blob.presignUrl).not.toHaveBeenCalled();
  });

  it("lets every other failure through", async () => {
    // A bad token and a dead network are not "no such object". Flattening
    // them into null would render a missing image where an outage happened.
    blob.head.mockRejectedValue(new Error("Access denied"));

    await expect(storage.get(KEY)).rejects.toThrow("Access denied");
  });
});

describe("the URLs it hands out", () => {
  it("signs a read URL for the key, against the private store", async () => {
    blob.head.mockResolvedValue(storedBlob());

    await storage.get(KEY);

    const [signedToken, options] = blob.presignUrl.mock.calls[0];
    expect(signedToken).toMatchObject({
      delegationToken: "delegation-token",
      clientSigningToken: "client-signing-token",
    });
    expect(options.operation).toBe("get");
    expect(options.pathname).toBe(KEY);
    // Has to match the store's own mode, so this is a second place the
    // public/private decision could drift away from `put`'s.
    expect(options.access).toBe("private");
  });

  it("expires them, about fifteen minutes out", async () => {
    blob.head.mockResolvedValue(storedBlob());

    const before = Date.now();
    await storage.get(KEY);
    const after = Date.now();

    // A window rather than an equality, since the module reads the clock
    // itself. What is being pinned is the order of magnitude: minutes, not
    // days, and not "never".
    const { validUntil } = blob.presignUrl.mock.calls[0][1];
    expect(validUntil).toBeGreaterThanOrEqual(before + 15 * MINUTE);
    expect(validUntil).toBeLessThanOrEqual(after + 15 * MINUTE);
  });

  it("asks for read, and only ever for read", async () => {
    // The delegation is store-wide, which is defensible precisely because it
    // is read-only and never leaves the server. A `put` or `delete` in this
    // array would turn the same material into a write credential.
    blob.head.mockResolvedValue(storedBlob());

    await storage.get(KEY);

    expect(blob.issueSignedToken.mock.calls[0][0].operations).toEqual(["get"]);
  });
});

describe("the delegation it signs with", () => {
  it("is issued once and reused across many URLs", async () => {
    // Why this is worth a test: a detail panel or a tree of portraits calls
    // `get` once per image. Issuing per URL would turn one page render into
    // thirty round trips to the control API, and nothing about the output
    // would look any different.
    blob.head.mockResolvedValue(storedBlob());

    await Promise.all([storage.get(KEY), storage.get(KEY), storage.get(KEY)]);

    expect(blob.issueSignedToken).toHaveBeenCalledTimes(1);
    expect(blob.presignUrl).toHaveBeenCalledTimes(3);
  });

  it("is scoped to the whole store, so one covers every image", async () => {
    blob.head.mockResolvedValue(storedBlob());

    await storage.get(KEY);

    expect(blob.issueSignedToken.mock.calls[0][0].pathname).toBe("*");
  });

  it("is re-issued once it can no longer cover a full-length URL", async () => {
    // A URL's expiry is capped to its delegation's, so a nearly-dead
    // delegation would quietly hand out nearly-dead URLs: fifteen minutes on
    // paper, ninety seconds in fact, and broken images that reproduce only
    // near the end of an hour.
    blob.issueSignedToken.mockResolvedValue({
      delegationToken: "delegation-token",
      clientSigningToken: "client-signing-token",
      validUntil: Date.now() + 2 * MINUTE,
    });
    blob.head.mockResolvedValue(storedBlob());

    await storage.get(KEY);
    await storage.get(KEY);

    expect(blob.issueSignedToken).toHaveBeenCalledTimes(2);
  });

  it("is re-issued when STORAGE_TOKEN changes underneath it", async () => {
    // Rotating the credential in a deploy environment, or a test stubbing a
    // different one. A cached delegation issued against the old value would
    // fail in a way that reads as an outage rather than as a rotation.
    blob.head.mockResolvedValue(storedBlob());

    await storage.get(KEY);
    vi.stubEnv("STORAGE_TOKEN", "vercel_blob_rw_rotated_token");
    await storage.get(KEY);

    expect(blob.issueSignedToken).toHaveBeenCalledTimes(2);
    expect(blob.issueSignedToken.mock.calls[1][0].token).toBe(
      "vercel_blob_rw_rotated_token",
    );
  });

  it("does not cache a failed issuance", async () => {
    // The failure that would otherwise be permanent: one transient error at
    // the control API, cached as a rejected promise, and every later read on
    // that function instance fails with a stale error nobody can clear.
    blob.head.mockResolvedValue(storedBlob());
    blob.issueSignedToken.mockRejectedValueOnce(new Error("control API down"));

    await expect(storage.get(KEY)).rejects.toThrow("control API down");
    await expect(storage.get(KEY)).resolves.toMatchObject({
      url: signed(KEY),
    });
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
