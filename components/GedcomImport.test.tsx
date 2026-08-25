// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GedcomImport } from "@/components/GedcomImport";
import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  type ImportDoneResponse,
  type ImportPreviewResponse,
} from "@/lib/import-endpoint";
import type { ImportCounts, ImportPreview } from "@/lib/import-preview";
import { render } from "@/test/render";

/**
 * The import screen (E6-T3, `YEO-48`).
 *
 * Two of this ticket's four acceptance criteria are properties of a *flow*
 * rather than of a value, and neither can be asserted anywhere but here:
 *
 * - **Explicit confirm step before anything is written.** Previewing must
 *   send no confirmation, and confirming must send the digest of the file
 *   that was previewed.
 * - **Cancelling leaves the database untouched.** Cancel must send nothing at
 *   all — not a request that is ignored, no request.
 *
 * So the assertions below are largely about `fetch`: how many times it was
 * called, and what was in the body each time. The counts, names and warnings
 * on the screen come from `lib/import-preview.ts` and are tested there
 * against real files; what is checked here is that they reach the page and
 * that the buttons around them do what they say.
 *
 * `fetch` is stubbed and nothing else is. That is the boundary Vitest cannot
 * cross (docs/testing.md: "mock a module boundary Vitest cannot cross, never
 * behaviour worth driving") — and it is exactly the boundary these tests are
 * about, since every request that does or does not cross it is the thing
 * being asserted.
 */

type Call = { url: string; body: FormData };

/**
 * One queued answer.
 *
 * `invalid` is an answer with no JSON in it — the guard's bare `401` body is
 * the one that happens in practice. `defer` holds the answer open until the
 * test lets it land, which is the only way to be in two states at once.
 */
type Answer = {
  status: number;
  body?: unknown;
  invalid?: boolean;
  defer?: boolean;
};

let calls: Call[] = [];
let answers: Answer[] = [];
let held: (() => void)[] = [];

/** Let React settle every microtask the last act produced. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  calls = [];
  answers = [];
  held = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as FormData });
      const answer = answers.shift();
      if (!answer) throw new Error(`No answer queued for ${url}`);

      const response = {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => {
          if (answer.invalid) throw new SyntaxError("Unexpected token");
          return answer.body;
        },
      } as Response;

      if (!answer.defer) return response;
      return new Promise<Response>((resolve) => {
        held.push(() => resolve(response));
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A preview with just enough in it to be recognisable on the screen. */
function previewOf(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    encoding: "utf-8",
    misdeclaredEncoding: null,
    counts: { people: 5, unions: 2, children: 2 },
    found: { people: 5, unions: 2 },
    refused: { people: 0, unions: 0 },
    sample: ["John Henry Smith", "Mary Ann Byrne"],
    warnings: [],
    unknownTags: [],
    unknownTagTotal: 0,
    unknownTagOccurrences: 0,
    ...overrides,
  };
}

function previewAnswer(
  preview: ImportPreview = previewOf(),
  digest = "abc123",
): ImportPreviewResponse {
  return { stage: "preview", digest, preview };
}

/** The answer to a confirmed import that ran. */
function importedAnswer(
  written: ImportCounts = { people: 5, unions: 2, children: 2 },
): ImportDoneResponse {
  return { stage: "imported", written };
}

function mount() {
  const host = render(<GedcomImport />);
  return {
    host,
    input: host.querySelector("input[type=file]") as HTMLInputElement,
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((element) =>
        element.textContent?.includes(label),
      ),
  };
}

/**
 * Choose a file.
 *
 * `files` is read-only on the element, and jsdom has no way to build a
 * `FileList`, so it is defined over the top — which is enough, because the
 * component only ever asks for `files[0]`.
 */
function choose(input: HTMLInputElement, name = "tree.ged"): File {
  const chosen = new File(["0 HEAD\n0 TRLR\n"], name, { type: "text/plain" });
  Object.defineProperty(input, "files", {
    configurable: true,
    value: Object.assign([chosen], { item: () => chosen }),
  });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return chosen;
}

async function click(element: HTMLElement | undefined): Promise<void> {
  if (!element) throw new Error("No such button on the screen");
  await act(async () => {
    element.click();
  });
  await settle();
}

describe("previewing a file", () => {
  it("asks for nothing until a file has been chosen", async () => {
    const screen = mount();
    expect(screen.button("Preview this file")?.disabled).toBe(true);

    choose(screen.input);
    expect(screen.button("Preview this file")?.disabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("uploads the file with no confirmation on it", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 200, body: previewAnswer() });

    await click(screen.button("Preview this file"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(IMPORT_ENDPOINT);
    expect(calls[0].body.get(IMPORT_FILE_FIELD)).toBeInstanceOf(File);
    // The whole point of the first request: it cannot be mistaken for
    // consent, because the field that carries consent is not in it.
    expect(calls[0].body.get(IMPORT_CONFIRM_FIELD)).toBeNull();
  });

  it("shows the counts, the names and the warnings", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({
      status: 200,
      body: previewAnswer(
        previewOf({
          warnings: [
            {
              kind: "unnamed",
              label: "People with no name in the file",
              count: 3,
              examples: [{ line: 12, message: "No name is recorded." }],
            },
          ],
        }),
      ),
    });

    await click(screen.button("Preview this file"));

    const text = screen.host.textContent ?? "";
    expect(text).toContain("John Henry Smith");
    expect(text).toContain("People with no name in the file");
    // The count is the fact and the example is there so it can be checked;
    // two of the three are not shown, and the screen says so rather than
    // implying the one it shows is all of them.
    expect(text).toContain("and 2 more");
    expect(text).toContain("Line 12");
  });

  it("says so when the file holds nobody", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({
      status: 200,
      body: previewAnswer(
        previewOf({
          counts: { people: 0, unions: 0, children: 0 },
          found: { people: 0, unions: 0 },
          sample: [],
        }),
      ),
    });

    await click(screen.button("Preview this file"));

    expect(screen.host.textContent).toContain("There is nobody in this file");
  });

  it("reports a refusal without pretending anything was written", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 413, body: { error: "That file is too large." } });

    await click(screen.button("Preview this file"));

    const alert = screen.host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("That file is too large.");
    expect(screen.button("Import 5 people")).toBeUndefined();
  });
});

describe("the confirm step", () => {
  async function previewed() {
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 200, body: previewAnswer(previewOf(), "deadbeef") });
    await click(screen.button("Preview this file"));
    return screen;
  }

  it("sends the digest of the file that was previewed", async () => {
    const screen = await previewed();
    answers.push({
      status: 501,
      body: { error: "Nothing was written.", pendingTicket: "E6-T4" },
    });

    await click(screen.button("Import 5 people"));

    expect(calls).toHaveLength(2);
    expect(calls[1].body.get(IMPORT_CONFIRM_FIELD)).toBe("deadbeef");
    expect(calls[1].body.get(IMPORT_FILE_FIELD)).toBeInstanceOf(File);
  });

  it("shows what was written and takes the preview down", async () => {
    // The preview described a decision that has now been made. Leaving "what
    // this file would add" beside what it did add is two answers to one
    // question, and the reader has no way to tell which is the outcome.
    const screen = await previewed();
    answers.push({ status: 200, body: importedAnswer() });

    await click(screen.button("Import 5 people"));

    expect(screen.host.textContent).toContain("What was imported");
    expect(screen.button("Import 5 people")).toBeUndefined();
  });

  it("says the tree is untouched when the import fails", async () => {
    const screen = await previewed();
    answers.push({
      status: 500,
      body: {
        error:
          "The import did not finish, and nothing was written — the tree is " +
          "exactly as it was. Try again.",
      },
    });

    await click(screen.button("Import 5 people"));

    expect(screen.host.querySelector('[role="alert"]')?.textContent).toContain(
      "nothing was written",
    );
    expect(screen.host.textContent).not.toContain("What was imported");
  });

  it("takes the preview down when a different file is chosen", async () => {
    // The preview and the digest under the import button both describe the
    // old bytes. Leaving either on screen is how somebody approves one file's
    // counts for another file's contents.
    const screen = await previewed();
    expect(screen.button("Import 5 people")).toBeDefined();

    choose(screen.input, "another.ged");

    expect(screen.button("Import 5 people")).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("an answer that is not what the screen expected", () => {
  it("says the session ran out rather than blaming the connection", async () => {
    // A `401` from the guard carries a bare body, so `response.json()`
    // throws. Telling that reader to check their connection would send them
    // looking in entirely the wrong place.
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 401, invalid: true });

    await click(screen.button("Preview this file"));

    expect(screen.host.querySelector('[role="alert"]')?.textContent).toContain(
      "signed out",
    );
  });

  it("discards a preview for a file the reader has moved on from", async () => {
    // Choosing a second file while the first is still being read. Without a
    // guard the first file's counts land under the second file's name, which
    // is the one confusion this screen exists to prevent.
    const screen = mount();
    choose(screen.input, "first.ged");
    answers.push({ status: 200, body: previewAnswer(), defer: true });

    await act(async () => {
      screen.button("Preview this file")?.click();
    });
    choose(screen.input, "second.ged");

    await act(async () => held.shift()?.());
    await settle();

    expect(screen.button("Import 5 people")).toBeUndefined();
    expect(screen.host.textContent).not.toContain("John Henry Smith");
  });
});

describe("cancelling", () => {
  it("sends nothing at all", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 200, body: previewAnswer() });
    await click(screen.button("Preview this file"));
    expect(calls).toHaveLength(1);

    await click(screen.button("Cancel"));

    // Not "a request that was ignored" — no second request exists. Every
    // other guarantee in this ticket rests on the write being a thing that
    // has to be asked for.
    expect(calls).toHaveLength(1);
    expect(screen.host.textContent).toContain("Nothing was imported");
    expect(screen.button("Import 5 people")).toBeUndefined();
  });

  it("empties the file input so the same file can be chosen again", async () => {
    const screen = mount();
    choose(screen.input);
    answers.push({ status: 200, body: previewAnswer() });
    await click(screen.button("Preview this file"));

    await click(screen.button("Cancel"));

    expect(screen.input.value).toBe("");
    expect(screen.button("Preview this file")?.disabled).toBe(true);
  });
});
