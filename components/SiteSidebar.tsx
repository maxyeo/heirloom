import Link from "next/link";

import { siteNavItems } from "@/lib/site-nav";

/**
 * The left sidebar: the navigation group the E11 reference mockup puts there,
 * and a slot beneath it for what comes next.
 *
 * Whether it is showing at all — a pinned column, a drawer over the article,
 * or nothing — is decided entirely by the `site-sidebar` class and the
 * `data-sidebar` attribute on `<html>`. See `app/globals.css` and
 * `lib/sidebar-preference.ts`. Nothing about that is in this component, which
 * is why it can stay a plain server component with no state of its own.
 */
export function SiteSidebar({
  id,
  children,
}: {
  /** Matches the hamburger's `aria-controls`. */
  id: string;
  /**
   * Rendered under the navigation group.
   *
   * This is where **E11-T3 (`YEO-73`)** hangs the pinned table of contents:
   * the mockup puts "Contents" directly below "Navigation" in this column, and
   * that ticket owns generating it from the article's headings and tracking
   * scroll position. Passed in from the route rather than imported here,
   * because the contents list needs the article and the shell does not know
   * about articles.
   */
  children?: React.ReactNode;
}) {
  return (
    <nav
      id={id}
      aria-labelledby={`${id}-heading`}
      className="site-sidebar border-r border-wash px-3 py-4 text-caption"
    >
      {/* The rule and the serif that globals.css gives an h2 are for article
          sections. This is furniture: small, sans, muted, the way the mockup
          labels its own nav group. */}
      <h2
        id={`${id}-heading`}
        className="mb-1.5 border-b-0 pb-0 font-sans text-note font-normal text-ink-muted"
      >
        Navigation
      </h2>

      {/* Preflight strips the markers and the chrome wants them stripped, so
          `role="list"` restores the semantics Safari/VoiceOver drop when they
          see `list-style: none` — the same reason `app/wiki/page.tsx` spells
          it out. */}
      <ul role="list" className="flex flex-col gap-1.5">
        {siteNavItems.map((item) => (
          <li key={item.label}>
            {item.href === null ? (
              // Inert, not a link to a page that will 404. E8-T4 turns this
              // into `<Link href="/recent-changes">` and deletes the branch.
              <span className="text-ink-muted">{item.label}</span>
            ) : (
              <Link href={item.href}>{item.label}</Link>
            )}
          </li>
        ))}
      </ul>

      {children ? <div className="mt-6">{children}</div> : null}
    </nav>
  );
}
