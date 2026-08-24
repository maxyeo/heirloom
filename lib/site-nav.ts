/**
 * The left sidebar's navigation group — the four links the E11 reference
 * mockup puts there, in the order it puts them.
 *
 * A list rather than four hand-written `<li>`s because two of the four are the
 * interesting case: the destination does not exist yet. Keeping that as data
 * means the sidebar renders a placeholder without an `if` per item, and means
 * the wiring is checkable without a DOM — see `lib/site-nav.test.ts`.
 */
export type SiteNavItem = {
  readonly label: string;
  /**
   * Where it goes, or `null` while nothing is there to go to. A `null` href is
   * rendered as inert text rather than as a link to a 404: a sidebar entry
   * that looks live and is not is worse than one that plainly says "later".
   */
  readonly href: string | null;
  /** The ticket that fills it in. Only set when `href` is `null`. */
  readonly pendingTicket?: string;
};

export const siteNavItems: readonly SiteNavItem[] = [
  { label: "Main page", href: "/" },
  // E1-T9. First of the two live entries and deliberately so: until search
  // exists, the index is the only way to reach an entry whose address you do
  // not already know.
  { label: "All entries", href: "/wiki" },
  // The E3 canvas.
  { label: "Family tree", href: "/tree" },
  // E8-T4. The one piece of sidebar furniture this ticket cannot finish.
  { label: "Recent changes", href: null, pendingTicket: "E8-T4" },
];
