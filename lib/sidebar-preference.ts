/**
 * Whether the left sidebar is showing, and how that survives a page load.
 *
 * ## Where the state lives
 *
 * On `<html>`, as `data-sidebar="open" | "closed"`, and the CSS in
 * `app/globals.css` reads it from there. Not in React state, for one reason:
 * the answer has to be on the element *before the first paint*, or every page
 * load flashes a sidebar the viewer collapsed three days ago. Only a
 * synchronous inline script — `sidebarBootScript` below — can be that early,
 * and the only element it can be sure exists is the document element.
 *
 * Absent the attribute (script blocked, JavaScript off) the stylesheet falls
 * back to the viewport: a column on a wide screen, nothing on a narrow one.
 * So the no-JS page is not a broken page, it is a page without a hamburger.
 *
 * ## Why the phone ignores the stored preference
 *
 * Wide and narrow are two different pieces of furniture wearing one control.
 * Wide, the sidebar is a pinned column and collapsing it is a lasting choice
 * about how much of the screen the article gets. Narrow, it is a drawer lying
 * *over* the article, and a drawer that opens itself on load is not a
 * preference being honoured, it is something to dismiss before reading. So the
 * stored value is a wide-screen preference, `resolveSidebarState` only
 * consults it on a wide screen, and `components/sidebar-state.ts` only writes
 * it there.
 */

export type SidebarState = "open" | "closed";

/** The attribute the stylesheet keys off, on `<html>`. */
export const SIDEBAR_ATTRIBUTE = "data-sidebar";

/** Namespaced, because `localStorage` is shared with everything on the origin. */
export const SIDEBAR_STORAGE_KEY = "heirloom:sidebar";

/**
 * 55rem — 880px, the width the reference mockup collapses its own two-column
 * grid at. Above it the sidebar is a pinned column; below it, a drawer. The
 * same number is spelled as a media query in `app/globals.css`; it has to be,
 * because CSS cannot read a JavaScript constant. `sidebarBootScript` and the
 * stylesheet disagreeing would show up as a sidebar that is open according to
 * the button and invisible according to the page.
 */
export const SIDEBAR_PINNED_QUERY = "(min-width: 55rem)";

/**
 * The state a page should open in.
 *
 * @param stored what `localStorage` holds, or `null` for a viewer who has
 *   never expressed an opinion — and for one whose browser refused to answer.
 * @param pinnedViewport whether the viewport is wide enough for the sidebar to
 *   be a column rather than a drawer.
 */
export function resolveSidebarState(
  stored: string | null,
  pinnedViewport: boolean,
): SidebarState {
  // A drawer never opens itself. See the header of this module.
  if (!pinnedViewport) return "closed";
  // Anything other than an explicit "closed" — including a value some other
  // version of this app wrote — means the column shows. Open is the default a
  // first-time viewer should get: a sidebar they can see is a sidebar they can
  // collapse, and one they cannot see is a hamburger they have to guess at.
  return stored === "closed" ? "closed" : "open";
}

/**
 * The same decision, as a string of JavaScript to run before the page paints.
 *
 * Hand-written rather than derived from `resolveSidebarState` via
 * `Function.prototype.toString`, so what ships is readable in view-source and
 * survives whatever the minifier does. The duplication is real, so
 * `lib/sidebar-preference.test.ts` executes this script against a stubbed
 * `matchMedia` and asserts it agrees with `resolveSidebarState` on every
 * combination of inputs.
 *
 * Everything is wrapped in `try`: a browser with site data blocked throws from
 * `localStorage` on access, not on read, and an exception here would abort the
 * script before the attribute is set and leave the CSS fallback in charge.
 */
export const sidebarBootScript = `(function(){try{
var pinned=typeof window.matchMedia==="function"&&window.matchMedia(${JSON.stringify(SIDEBAR_PINNED_QUERY)}).matches;
var stored=null;try{stored=window.localStorage.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)});}catch(e){}
document.documentElement.setAttribute(${JSON.stringify(SIDEBAR_ATTRIBUTE)},!pinned?"closed":stored==="closed"?"closed":"open");
}catch(e){}})();`;
