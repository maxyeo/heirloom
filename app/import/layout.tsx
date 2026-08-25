import { SiteChrome } from "@/app/site-chrome";

/**
 * The import screen gets the same shell as an article — a column of prose
 * with the sidebar beside it, which is what it is.
 *
 * `force-dynamic` for the same reason every other segment declares it: the
 * shell reads the session cookie, so there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

export default function ImportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteChrome>{children}</SiteChrome>;
}
