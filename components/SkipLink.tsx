"use client";

/**
 * A link that jumps a keyboard user past a block of content (`YEO-108`).
 *
 * WCAG 2.4.1 ("Bypass Blocks") is about repeated content: if the same block
 * stands between the reader and the page every time, there has to be a way
 * over it. This application has two, and this is the one mechanism both use —
 * the shell's header and sidebar (`components/AppShell.tsx`), and the tree
 * canvas (`components/FamilyTree.tsx`), which spends one tab stop per person
 * and so costs two hundred keystrokes on a family of two hundred.
 *
 * Nothing is hidden and nothing is removed from the tab order: the node order
 * `YEO-69` established is exactly as it was for a reader who does not take the
 * link. This only adds a stop *before* the block and a place to land *after*
 * it.
 *
 * ## Why the target needs `tabIndex={-1}`
 *
 * Following a fragment link moves the reader's *scroll* position for free, but
 * it only moves *focus* if the thing it arrives at can hold focus. Without
 * `tabindex="-1"` on the target the next Tab carries on from the link — which
 * is to say, straight back into the block that was just skipped, which is the
 * failure mode that makes a skip link look implemented and not be. Callers own
 * their own target, because only they know what "past this" means; see
 * `TREE_SKIP_TARGET_ID` and `CONTENT_ID` for the two.
 *
 * ## Why there is a click handler as well as an `href`
 *
 * The `href` is the real mechanism and works before this component has
 * hydrated. The handler does the same thing explicitly, for two reasons: focus
 * on fragment navigation has a long history of browsers disagreeing about it,
 * and — the reason it is worth the "use client" — it is what makes the
 * behaviour assertable. `components/SkipLink.test.tsx` and
 * `components/FamilyTree.test.tsx` check that focus actually lands past the
 * canvas rather than that the markup for it is present, and jsdom implements
 * no fragment navigation to observe.
 *
 * `preventDefault` is deliberately *not* called: the browser's own behaviour
 * and this handler want the same thing, so letting both run leaves the URL
 * carrying the fragment the reader jumped to, exactly as any other in-page
 * anchor does.
 */
export function SkipLink({
  targetId,
  children,
}: {
  /** The `id` of the element focus should land on. It must be focusable. */
  targetId: string;
  /** What the link says once it appears. "Skip …", in the reader's words. */
  children: React.ReactNode;
}) {
  return (
    <a
      href={`#${targetId}`}
      /* Off-screen until focused. The whole of it is in `app/globals.css`. */
      className="skip-link"
      onClick={() => {
        document.getElementById(targetId)?.focus();
      }}
    >
      {children}
    </a>
  );
}
