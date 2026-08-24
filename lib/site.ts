/**
 * The wiki's own name, and the line that goes under every article title.
 *
 * `NEXT_PUBLIC_SITE_TITLE` is the one thing an install renames — the seed
 * family is not called Heirloom — and before E11-T2 the fallback was spelled
 * out at four separate call sites. The tagline is about to become a fifth and
 * a sixth (the shell's wordmark and the article heading), so it is worth one
 * module.
 *
 * `NEXT_PUBLIC_` is deliberate rather than incidental: the name is on the page
 * for everyone who can already see the page, so there is nothing to keep on
 * the server, and Next inlines the literal at build time for whichever bundle
 * asks for it.
 */
export function siteName(): string {
  return process.env.NEXT_PUBLIC_SITE_TITLE ?? "Heirloom";
}

/**
 * Wikipedia prints "From Wikipedia, the free encyclopedia" under the title of
 * every article. This is that line, and it is the reason the shell reads as an
 * encyclopedia rather than as a blog with serif headings.
 */
export function articleTagline(): string {
  return `From ${siteName()}, the family wiki`;
}
