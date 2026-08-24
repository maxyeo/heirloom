"use client";

import { usePathname } from "next/navigation";

import { ArticleTabs } from "@/components/ArticleTabs";

/**
 * The article tabs, joined to the address bar (E11-T7).
 *
 * ## Why this is a component of its own
 *
 * `usePathname` is a Client Component hook — Next's own docs are explicit that
 * reading the current URL from a Server Component is unsupported, by design,
 * so that layout state survives a navigation. `AppShell` is a Server
 * Component, so somebody in between has to be the client boundary, and these
 * five lines are it.
 *
 * Making `ArticleTabs` that component instead would have cost the same thing
 * it cost the canvas in E2-T4: `next/navigation` imports perfectly well
 * outside the App Router and then quietly returns nothing, so a suite that
 * mounts the tabs with no router above them would be asserting against a
 * pathname of `null` rather than failing usefully. So the tabs take the path,
 * this file reads it, and `lib/article-tabs.ts` holds the arithmetic between
 * them — the shape docs/testing.md sets out as **take it, do not import it**.
 *
 * ## Why there is no `<Suspense>` around this
 *
 * `usePathname` only needs one when `cacheComponents` is enabled and the
 * pathname cannot be resolved during prerendering. It is not enabled
 * (`next.config.ts`), and every route the shell wraps declares
 * `dynamic = "force-dynamic"` because it reads the session cookie — so there
 * is no prerender for this to suspend during. Worth revisiting if either of
 * those changes.
 */
export function RoutedArticleTabs() {
  return <ArticleTabs pathname={usePathname()} />;
}
