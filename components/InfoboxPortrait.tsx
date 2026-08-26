"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * The portrait at the top of a person's article (`YEO-97`).
 *
 * Its own file, and its own `"use client"`, for one reason: everything else
 * in `components/PersonInfobox.tsx` is markup over a value that was decided
 * on the server, and it should stay that way. A portrait is the one thing in
 * the box that can fail *after* it has been rendered — the row holds a key,
 * the object behind the key is gone — and noticing that needs an `onError`,
 * which needs the client. Splitting it here keeps the boundary the size of
 * the problem rather than making the whole box interactive.
 *
 * ## What it does when the image will not load
 *
 * It removes itself. Not a silhouette: the box's rule is that a person with
 * no portrait gets no figure rather than a picture of somebody nobody
 * uploaded, and a portrait whose bytes have gone is the same state arrived at
 * from a different direction — there is no photograph to show. That is the
 * opposite of `components/PersonPortrait.tsx`, which swaps in a placeholder,
 * and for the reason that component gives: the tree canvas reserves a
 * fixed-size box for every person so its layout cannot move, so it needs
 * *something* to put in it. An article is ordinary flow and needs nothing.
 *
 * This is not a hypothetical. `GET /api/images/…` answers 404 for an object
 * that is no longer in the store — "an ordinary answer, not an exception", in
 * its own words — and E5-T5's orphan sweep is a path that produces exactly
 * that. A key can also outlive its object through a restore from a database
 * backup taken after the image was deleted.
 *
 * The collapse costs one reflow of the article text on a page where the
 * alternative is the browser's broken-image glyph sitting under the name for
 * as long as the row is wrong. That trade is only acceptable because it is
 * the *failure* path: the ordinary load reserves its space up front and never
 * moves, which is the whole of the layout argument in `PersonInfobox`.
 *
 * ## Why it remembers which `src` failed
 *
 * The same subtlety `PersonPortrait` documents. A boolean would be wrong the
 * moment React reuses this element across two people — a client navigation
 * from one article to the next — because one missing photograph would then
 * hide the next person's. Storing the address makes the failure belong to the
 * image it happened to, and a new `src` resets it with no effect and no
 * cascading render.
 */
export function InfoboxPortrait({ src, name }: { src: string; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return null;

  return (
    <figure className="border-b border-rule-soft">
      {/*
        The square is what makes the load shift-free: the ratio is reserved
        before the bytes arrive, so the article text wraps once. Nothing
        stores a photograph's dimensions, so it is reserved rather than
        discovered. `max-w-infobox` caps it at the width the box has when it
        floats, which matters below `sm` where the box is as wide as the
        article — without it a phone would open on a portrait as tall as the
        column is wide. `relative` is what `fill` needs to size against.
      */}
      <div className="relative mx-auto aspect-square w-full max-w-infobox">
        <Image
          src={src}
          alt={`Portrait of ${name}`}
          fill
          /*
            Never rendered wider than the infobox, at any breakpoint, so the
            browser is told one width rather than left to assume the whole
            viewport.
          */
          sizes="20.5rem"
          /*
            The `src` is `/api/images/…`: a session-checked redirect to a
            private, expiring signed URL. Next's optimiser "will _not_ forward
            headers when fetching the `src` image" and recommends
            `unoptimized` for exactly this
            (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`),
            and letting it follow the redirect would mean naming the storage
            host in `next.config.ts` — the vendor written into the build
            configuration, which is what `lib/storage.call-sites.test.ts` and
            docs/architecture.md's storage seam exist to prevent.
            `components/PersonPortrait.tsx` makes the same call.
          */
          unoptimized
          onError={() => setFailedSrc(src)}
          /*
            `object-cover` crops to the reserved square — the same crop this
            face already gets on the canvas and in the detail panel, so the
            article invents no framing the author has not already seen.
          */
          className="object-cover"
        />
      </div>
    </figure>
  );
}
