"use client";

import Image from "next/image";
import { useState } from "react";

import { PORTRAIT_NODE_SIZE } from "@/lib/portrait";

/**
 * A person's face, or the space where one would go (E5-T4, `YEO-44`).
 *
 * ## Why the placeholder is this component and not a sibling of it
 *
 * The acceptance criterion is that the tree's layout is identical whether or
 * not a portrait exists. Two components — one that draws a photograph and one
 * that draws a placeholder — would satisfy that only for as long as two sets
 * of class names stayed in step, which is to say until somebody adjusted one
 * of them. Here there is **one box, always rendered, at a size that is not
 * negotiable**, and only its *child* differs. Nothing inside it can change
 * its geometry, so "the layout does not move" is a fact about the markup
 * rather than a promise about maintenance.
 *
 * That is also what makes it testable without a layout engine: jsdom reports
 * every element as zero by zero, so a test cannot measure this. It can assert
 * that the same box, with the same attributes, is rendered in both cases.
 *
 * ## Why the size is an inline style
 *
 * The number has to be the same one `lib/tree-layout.ts` adds to
 * `PERSON_WIDTH`, because dagre reserves space the browser then has to
 * actually use. A Tailwind class would say `48` in a second place, in a
 * different notation, with nothing connecting the two — and the failure would
 * be silent overlap between cards. Importing the constant and writing it into
 * the style is the version where the layout cannot disagree with itself.
 *
 * ## Why `unoptimized`
 *
 * The `src` is `/api/images/…`, which requires a session and answers with a
 * redirect to a private, expiring signed URL. Next's optimiser fetches the
 * source itself and, in its own words, "will _not_ forward headers when
 * fetching the `src` image… If the `src` image requires authentication,
 * consider using the unoptimized property"
 * (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`).
 * It would also have to be allowed to follow the redirect off-site, which
 * means naming the storage host in `next.config.ts` — writing the vendor into
 * the build configuration, from precisely the direction
 * `lib/storage.call-sites.test.ts` does not watch, and undoing the
 * portability claim the same way `docs/architecture.md` refuses to let the
 * sanitiser allowlist do it.
 *
 * There is nothing to optimise anyway: what the canvas loads is a thumbnail
 * this application already downscaled on the way in (`lib/portrait.ts`).
 */

/**
 * How large the portrait is drawn in the detail panel, in CSS pixels.
 *
 * Twice the node's, and bounded by the panel: it is 320 wide with 16 of
 * padding each side, so 96 leaves room for the name and the years beside it
 * rather than pushing them onto a line of their own. Unlike the node's size
 * this number is not load-bearing for any layout — the panel is a flow, not a
 * graph — so it is a design choice and nothing depends on it.
 */
export const PORTRAIT_PANEL_SIZE = 96;

export interface PersonPortraitProps {
  /**
   * Where to fetch the image from, or null when this person has no portrait.
   *
   * A resolved site-relative path rather than a storage key: turning one into
   * the other is `lib/portrait.ts`'s job, and it has already been done by the
   * time a value reaches a component. See `portraitSrc`.
   */
  src: string | null;
  /** Whose face this is, for the alt text. */
  name: string;
  /**
   * How large to draw it.
   *
   * `node` is the tree canvas, where the size is dictated by the layout;
   * `panel` is the detail panel, where it is not.
   */
  size: "node" | "panel";
}

export function PersonPortrait({ src, name, size }: PersonPortraitProps) {
  const edge = size === "node" ? PORTRAIT_NODE_SIZE : PORTRAIT_PANEL_SIZE;

  /**
   * A portrait whose bytes are gone renders as the placeholder rather than as
   * a broken-image glyph.
   *
   * Not a hypothetical: `GET /api/images/…` answers 404 for an object that is
   * no longer in the store, which its own docblock calls "an ordinary answer,
   * not an exception", and E5-T5's orphan sweep is a path that will produce
   * exactly that. A key can also outlive its object through a restore from a
   * database backup taken after the image was deleted.
   *
   * What is remembered is **which** `src` failed, not that one did. React
   * reuses this element across people — the detail panel swaps person without
   * unmounting, and React Flow keeps a node's DOM as the graph changes — so a
   * boolean would make one missing photograph hide the next person's. Storing
   * the address makes the failure belong to the image it happened to, and the
   * comparison below resets it with no effect and no cascading render.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;

  return (
    <div
      // `shrink-0` because the box is a fixed slot inside a flex row: without
      // it a long name would compress the portrait and, on the canvas, make
      // the card's geometry depend on its text after all.
      className="shrink-0 overflow-hidden rounded-panel border border-rule-soft bg-wash"
      style={{ width: edge, height: edge }}
    >
      {src !== null && !failed ? (
        <Image
          src={src}
          /**
           * Empty on the canvas, because the node already announces the
           * person: `lib/tree-layout.ts` puts their name and lifespan in the
           * node's `ariaLabel`, and a second announcement would make a
           * screen reader read every card twice. In the panel the portrait is
           * a thing on the page in its own right, so it says what it is.
           */
          alt={size === "node" ? "" : `Portrait of ${name}`}
          width={edge}
          height={edge}
          unoptimized
          /**
           * The whole reason a few hundred of these are affordable. React
           * Flow renders every node into the DOM, so without this a tree of
           * three hundred people would fetch three hundred images at once —
           * each one a request this application has to authorise and sign.
           * The browser's own visibility check sees through React Flow's
           * transform, so what is actually fetched is what is actually on
           * screen.
           */
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <PortraitPlaceholder />
      )}
    </div>
  );
}

/**
 * The stand-in for a face nobody has found yet.
 *
 * **Inline SVG, not an image.** An `<img src="/silhouette.svg">` would be a
 * network request per person on a canvas where most people have no portrait —
 * cached after the first, but still a decode and an element with a load state
 * for every card. This is markup the node already has.
 *
 * Deliberately plain: a head and shoulders in the muted ink the rest of the
 * secondary text uses. It should read as "no photograph", not as an avatar
 * this application has assigned somebody — a generated identicon or a
 * coloured initial would be a fact about the person that nobody recorded,
 * which is the same mistake as writing 1 January into a birth date that is
 * only known to the year.
 *
 * `aria-hidden`, because it says nothing. A reader who cannot see it is not
 * missing information; there is none.
 */
function PortraitPlaceholder() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-full w-full text-ink-muted opacity-40"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-testid="portrait-placeholder"
    >
      <circle cx="12" cy="9" r="4" />
      <path d="M12 14c-4.4 0-8 2.7-8 6v4h16v-4c0-3.3-3.6-6-8-6z" />
    </svg>
  );
}
