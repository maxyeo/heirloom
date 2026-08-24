import { SiteChrome } from "@/app/site-chrome";

/**
 * The shell wraps everything under `/wiki` — the index, an entry, the editor,
 * the history views, and the segment's `not-found`, which renders inside the
 * nearest layout above it.
 *
 * `force-dynamic` for the same reason every page in here already declares it:
 * the shell reads the session cookie, so there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

export default function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteChrome>{children}</SiteChrome>;
}
