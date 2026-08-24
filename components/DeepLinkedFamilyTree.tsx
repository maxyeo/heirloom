"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { FamilyTree, type FamilyTreeProps } from "@/components/FamilyTree";
import {
  PERSON_PARAM,
  personSearch,
  type PersonLink,
} from "@/lib/tree-selection";

export type DeepLinkedFamilyTreeProps = Omit<FamilyTreeProps, "personLink">;

/**
 * The canvas, joined to the address bar (E2-T4).
 *
 * ## Why this is a component of its own
 *
 * `useSearchParams` only works underneath the App Router's own providers, and
 * `app/tree/page.tsx` is a Server Component, so somebody in between has to be
 * a Client Component that reads it. Making `FamilyTree` that component would
 * have cost more than a file: `components/FamilyTree.test.tsx` mounts the real
 * canvas in jsdom with no router anywhere, and the hook returns `null` there —
 * so every one of that file's twenty-odd assertions would have gone down with
 * the first `searchParams.get`.
 *
 * That is the same wall E3-T4 hit from the other side, and the same way round
 * it (docs/testing.md): **a Client Component that a test may want to mount
 * should take what it needs, not import it.** There it was a server action;
 * here it is the URL. The canvas is handed a `PersonLink` and knows nothing
 * about routing, this file is the ten lines that know about routing and are
 * not worth mounting, and the arithmetic between them is in
 * `lib/tree-selection.ts` where it can be asserted with no DOM at all.
 *
 * ## Why `history.pushState` rather than `router.push`
 *
 * `/tree` is `force-dynamic` — it reads the whole family graph out of Postgres
 * on every render. A `router.push` for each node click would therefore be a
 * round trip to the database to re-render a route whose data did not change,
 * to move a highlight the browser has already moved.
 *
 * `window.history.pushState` is the framework's own answer to that: Next
 * patches it, so the pushed URL becomes the one `useSearchParams` reports and
 * the entry it leaves behind is one the router recognises on `popstate`. Back
 * and forward then arrive here as a changed `personId` and nothing else — no
 * fetch, no remount, and the canvas keeps its viewport.
 */
export function DeepLinkedFamilyTree(props: DeepLinkedFamilyTreeProps) {
  const searchParams = useSearchParams();
  const personId = searchParams.get(PERSON_PARAM);

  /**
   * Read from `window.location` rather than from `usePathname` and the
   * `searchParams` above, so that this callback is stable for the life of the
   * canvas and cannot push a *stale* query string. It is called from an effect
   * in the render that changed the selection, which is one render before the
   * router has caught up with the URL that effect is about to write.
   */
  const onChange = useCallback((next: string | null) => {
    const { pathname, search } = window.location;
    window.history.pushState(
      null,
      "",
      `${pathname}${personSearch(search, next)}`,
    );
  }, []);

  const personLink = useMemo<PersonLink>(
    () => ({ personId, onChange }),
    [personId, onChange],
  );

  return <FamilyTree {...props} personLink={personLink} />;
}
