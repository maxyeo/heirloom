import { RESERVED_SLUGS } from "@/lib/entry-slug";

/**
 * The Article / Read / Edit / View history row that sits above an entry
 * (E11-T7, `YEO-77`) — as a function of the current path, with no DOM and no
 * router in sight.
 *
 * ## Why this is a module rather than a component
 *
 * Everything the tab row *decides* is arithmetic on a string: whether this
 * path is an article at all, which slug it belongs to, and which of the four
 * tabs is the one you are looking at. docs/testing.md's "prefer no DOM" rule
 * is exactly about this shape, so the deciding lives here where a test can
 * hand it `/wiki/ada/history/compare` and read the answer back, and
 * `components/ArticleTabs.tsx` is left with markup.
 *
 * ## Why "Article" is not a link
 *
 * Wikipedia's tab row has two groups. On the left the *namespace* tabs —
 * Article and Talk — say which of the two parallel pages you are on; on the
 * right the *view* tabs — Read, Edit, View history — say what you are doing to
 * it. "Article" is a link there because there is somewhere to come back from:
 * Talk.
 *
 * The ticket rules a Talk namespace out, and gives the reason: this wiki has a
 * handful of named family members and `docs/product.md` lists collaborative
 * editing as a non-goal, so a Talk page would be a permanently empty room.
 * With one namespace, "Article" has nowhere to link *to* except the read view
 * sitting immediately to its right. So it is rendered as what it actually is:
 * a label saying which namespace you are in, always selected, and not a
 * control. Making it a second link to the same address would give a screen
 * reader two "current page" links in a row and give a mouse two ways to do one
 * thing.
 *
 * ## Why an unrecognised sub-route gets no tabs
 *
 * `articleTabsForPath` returns `null` for anything under `/wiki/<slug>/` it
 * does not know — a route added later, before someone teaches this file about
 * it. The alternative is worse than missing tabs: a row that renders with
 * *nothing* marked current, or with "Read" wrongly marked current, is a row
 * that lies about where you are. `lib/article-tabs.test.ts` checks the paths
 * named here against the directories actually present under `app/wiki/[slug]`,
 * so a route that disappears or moves fails a test rather than producing a
 * link to a 404.
 *
 * ## The one thing a path cannot tell you
 *
 * Whether the entry exists. `/wiki/nobody-wrote-this` is a well-formed article
 * path that `page.tsx` answers with `notFound()`, and the tab row renders above
 * that 404 with Edit and View history pointing at two more of them. It cannot
 * be fixed here: the row is rendered by the shell, the shell is a layout, and a
 * layout is not told that the page below it threw.
 *
 * It is also roughly what Wikipedia does — a title nobody has written still
 * gets a tab row, because the tabs are how you act on an address rather than a
 * report on what is at it. If it becomes worth changing, the tab to change is
 * "Edit", which would read "Create" rather than disappear, and the knowledge of
 * which slugs exist is E11-T6's (`lib/entry-links.ts`) rather than this file's.
 */

/** Which of the four tabs a row is talking about. */
export type ArticleTabId = "article" | "read" | "edit" | "history";

/**
 * Which group a tab belongs to, and so which end of the row it sits at.
 * `"namespace"` is the left-hand group ("Article"); `"view"` is the right-hand
 * one, and the group the narrow-screen overflow menu collapses.
 */
export type ArticleTabGroup = "namespace" | "view";

export type ArticleTab = {
  readonly id: ArticleTabId;
  readonly label: string;
  readonly group: ArticleTabGroup;
  /**
   * Where the tab goes, or `null` for a tab that is a label rather than a
   * control — see "Why 'Article' is not a link" above.
   */
  readonly href: string | null;
  /** Whether this tab is the selected one within its own group. */
  readonly current: boolean;
};

export type ArticleTabRow = {
  /**
   * The `[slug]` segment, exactly as it appeared in the path.
   *
   * Deliberately *not* decoded. It came out of a URL, so it is already a valid
   * URL segment, and pasting it back into one round-trips whatever encoding it
   * arrived in — which matters here because `lib/entry-slug.ts` keeps non-Latin
   * titles in the address (`/wiki/北京` is a real entry). Decoding it to build
   * a link would mean re-encoding it correctly afterwards, and there is nothing
   * to gain from the detour: no tab displays the slug.
   */
  readonly slug: string;
  /** Article, Read, Edit, View history — in the order they are rendered. */
  readonly tabs: readonly ArticleTab[];
  /**
   * The selected tab of the `"view"` group, which is what the narrow-screen
   * overflow trigger is labelled with. Always one of `tabs`.
   */
  readonly currentView: ArticleTab;
};

/** The label Wikipedia gives each tab, and the order it gives them in. */
const TAB_LABELS: Readonly<Record<ArticleTabId, string>> = {
  article: "Article",
  read: "Read",
  edit: "Edit",
  history: "View history",
};

/**
 * The view a path below `/wiki/<slug>` is showing, or `undefined` if this
 * file does not recognise it.
 *
 * The history *view* covers four routes, not one: the list (E1-T5), a single
 * revision, the compare view (E1-T6) and the restore confirmation (E1-T7).
 * They are all "you are reading this entry's history", so they all light the
 * same tab — which is why this matches on the first segment below the slug
 * rather than on the whole remainder.
 */
function viewForRest(rest: readonly string[]): ArticleTabId | undefined {
  if (rest.length === 0) return "read";
  if (rest.length === 1 && rest[0] === "edit") return "edit";
  if (rest[0] === "history") return "history";
  return undefined;
}

/**
 * `RESERVED_SLUGS` holds decoded names, so a percent-encoded segment has to be
 * decoded before it can be compared with them. A malformed escape throws from
 * `decodeURIComponent` rather than returning anything, and a path that cannot
 * be decoded is not a path that matches a reserved word — so it falls through
 * to the raw segment, which will not match either.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The tab row for a path, or `null` where there is no article to put tabs on.
 *
 * `null` covers every non-article page the shell also wraps — `/`, `/tree`,
 * the entry index at `/wiki`, and the create form at `/wiki/new`, whose entry
 * does not exist yet and so has no history to view and nothing to edit.
 *
 * @param pathname the current URL's path, as `usePathname()` reports it:
 *   no query string, no hash.
 */
export function articleTabsForPath(pathname: string): ArticleTabRow | null {
  // A leading "" from the leading slash, and a trailing "" from a trailing
  // one, are both dropped by the filter — so `/wiki/ada/` reads the same as
  // `/wiki/ada`.
  const segments = pathname.split("/").filter(Boolean);

  const [root, slug, ...rest] = segments;
  if (root !== "wiki" || !slug) return null;

  // `/wiki/new` is the create form, not an entry. The set is shared with
  // `lib/entry-slug.ts` rather than restated, so a second static route added
  // under `/wiki` cannot start showing tabs here while being refused as a slug
  // there.
  if (RESERVED_SLUGS.has(decodeSegment(slug))) return null;

  const view = viewForRest(rest);
  if (!view) return null;

  const base = `/wiki/${slug}`;

  const tabs: readonly ArticleTab[] = [
    {
      id: "article",
      label: TAB_LABELS.article,
      group: "namespace",
      href: null,
      // The only namespace there is, so it is always the selected one.
      current: true,
    },
    {
      id: "read",
      label: TAB_LABELS.read,
      group: "view",
      href: base,
      current: view === "read",
    },
    {
      id: "edit",
      label: TAB_LABELS.edit,
      group: "view",
      href: `${base}/edit`,
      current: view === "edit",
    },
    {
      id: "history",
      label: TAB_LABELS.history,
      group: "view",
      href: `${base}/history`,
      current: view === "history",
    },
  ];

  const currentView = tabs.find((tab) => tab.group === "view" && tab.current);
  // Unreachable: `viewForRest` returns one of the three view ids or nothing,
  // and each is spelled once above. Stated rather than asserted with a
  // non-null assertion, so the type is earned instead of escaped.
  if (!currentView) throw new Error(`no view tab matches ${pathname}`);

  return { slug, tabs, currentView };
}
