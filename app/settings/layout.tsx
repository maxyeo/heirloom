import { SiteChrome } from "@/app/site-chrome";

/**
 * The settings screen gets the same shell as an article — a column of prose
 * with the sidebar beside it — for the same reason `app/import/layout.tsx`
 * does: that is what it is.
 *
 * `force-dynamic` for the same reason every other segment declares it: the
 * shell reads the session cookie, so there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteChrome>{children}</SiteChrome>;
}
