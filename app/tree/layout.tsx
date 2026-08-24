import { SiteChrome } from "@/app/site-chrome";

/**
 * The tree gets the same shell as an article. It is the one route whose
 * content is a canvas rather than a column, which is why the shell does not
 * impose `max-w-content` on what it wraps — see `components/AppShell.tsx`.
 *
 * `force-dynamic` for the same reason `app/tree/page.tsx` already declares it:
 * the shell reads the session cookie, so there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

export default function TreeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteChrome>{children}</SiteChrome>;
}
