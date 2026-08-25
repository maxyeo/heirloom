import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring of the image route (E5-T2, `YEO-42`).
 *
 * This is the half of the ticket where a storage key is *not* minted by this
 * application — the segments come out of a URL a stranger typed. So the
 * traversal cases below are the ones with stakes, and they are the reason the
 * key validator this ticket owes `lib/storage.ts` ships in the same change as
 * the endpoint that would otherwise be its only, unexploitable, caller.
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

const { GET } = await import("@/app/api/images/[...key]/route");

const SIGNED_URL =
  "https://abc123.private.blob.vercel-storage.com/images/ab/x.jpg?signature=sig";

const request = new Request("http://localhost/api/images/ab/x.jpg");

const ask = (segments: string[]) =>
  GET(request, { params: Promise.resolve({ key: segments }) });

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  storage.get.mockReset();
  storage.get.mockResolvedValue({
    key: "images/ab/x.jpg",
    url: SIGNED_URL,
    contentType: "image/jpeg",
  });
});

describe("the guard", () => {
  it("answers 401 to a caller with no session", async () => {
    state.session = null;
    const response = await ask(["ab", "x.jpg"]);

    expect(response.status).toBe(401);
    // Photographs are inside the ALLOWED_EMAILS boundary, which means the
    // store is never even asked on behalf of a stranger.
    expect(storage.get).not.toHaveBeenCalled();
  });
});

describe("resolving a key", () => {
  it("redirects to a freshly signed URL", async () => {
    const response = await ask(["ab", "x.jpg"]);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_URL);
    expect(storage.get).toHaveBeenCalledWith("images/ab/x.jpg");
  });

  it("forbids caching the redirect, because its target expires", async () => {
    // Fifteen minutes. A cached 302 would outlive its own target and serve a
    // dead link out of the browser cache long after a reload would have fixed
    // it.
    const response = await ask(["ab", "x.jpg"]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 when nothing is stored there", async () => {
    // An ordinary answer rather than an error: revisions are append-only, so
    // a body outlives the image it points at.
    storage.get.mockResolvedValue(null);
    expect((await ask(["ab", "gone.jpg"])).status).toBe(404);
  });
});

describe("a key that is not this application's to serve", () => {
  it.each([
    ["climbing out of the namespace", ["..", "..", "etc", "passwd"]],
    ["a current-directory segment", [".", "x.jpg"]],
    ["an absolute path", ["", "etc", "passwd"]],
    ["a backslash", ["ab", "x\\..\\y.jpg"]],
    ["a NUL", ["ab", "x.jpg\0.txt"]],
  ])("is refused: %s", async (_reason, segments) => {
    const response = await ask(segments);

    expect(response.status).toBe(400);
    // The check happens before the store is touched, which is what "validated
    // before they reach lib/storage.ts" means.
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("cannot reach a sibling namespace in the same store", async () => {
    // The route adds the `images/` prefix itself, so nothing a caller writes
    // can address a backup or an export that later shares the store.
    await ask(["ab", "x.jpg"]);
    expect(storage.get.mock.calls[0][0].startsWith("images/")).toBe(true);
  });
});
