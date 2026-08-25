import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMAGE_TYPES,
  extensionFor,
  sniffImageType,
} from "@/lib/image-type";
import { GIF, jpeg, png, webp, IHDR, VP8X } from "@/test/image-fixtures";

/**
 * The allowlist (E5-T2, `YEO-42`).
 *
 * The interesting assertions here are the negative ones. Sniffing accepts
 * four fixed byte strings and refuses everything else, so what has to be
 * proved is not that a JPEG is recognised — that is one comparison — but
 * that the things which *look* close enough to slip through do not: a RIFF
 * container that is not a WebP, an SVG that says it is an image in its own
 * first line, and an HTML document with an image's media type written on the
 * part that carried it.
 */

const bytes = (text: string): Uint8Array =>
  new Uint8Array([...text].map((character) => character.charCodeAt(0)));

describe("the allowlist", () => {
  it("is the four types the ticket names", () => {
    expect([...ALLOWED_IMAGE_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
  });

  it("has exactly one extension per type", () => {
    expect(ALLOWED_IMAGE_TYPES.map(extensionFor)).toEqual([
      "jpg",
      "png",
      "webp",
      "gif",
    ]);
  });
});

describe("what is recognised", () => {
  it.each([
    ["a JPEG", jpeg([]), "image/jpeg"],
    ["a PNG", png([{ type: "IHDR", data: IHDR }]), "image/png"],
    ["a WebP", webp([{ type: "VP8X", data: VP8X }]), "image/webp"],
    ["a GIF89a", GIF, "image/gif"],
    ["a GIF87a", bytes("GIF87a\0\0"), "image/gif"],
  ])("%s", (_name, file, expected) => {
    expect(sniffImageType(file)).toBe(expected);
  });
});

describe("what is not", () => {
  it.each([
    ["an SVG, which is a document with script in it", bytes("<svg xmlns=")],
    ["an HTML file", bytes("<!DOCTYPE html><html>")],
    ["a PDF", bytes("%PDF-1.7")],
    [
      "a WAV, which is also a RIFF file",
      bytes("RIFF\u0000\u0000\u0000\u0000WAVE"),
    ],
    ["an AVI, likewise", bytes("RIFF\u0000\u0000\u0000\u0000AVI ")],
    ["a truncated PNG signature", bytes("\x89PNG")],
    ["nothing at all", new Uint8Array()],
  ])("%s", (_name, file) => {
    expect(sniffImageType(file)).toBeNull();
  });

  it("does not care what the upload called itself", () => {
    // The whole point of reading the bytes: `curl -F
    // 'file=@shell.html;type=image/png'` is one flag long, and the media type
    // on a multipart part is whatever the client wrote there.
    expect(sniffImageType(bytes("<!DOCTYPE html>"))).toBeNull();
  });
});
