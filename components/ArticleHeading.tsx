import { articleTagline } from "@/lib/site";

/**
 * An article's title and the line under it — "From Heirloom, the family wiki".
 *
 * The pair is one component rather than two elements at each call site because
 * of where the rule goes. `globals.css` puts a bottom rule on every `h1`, which
 * is right for a heading standing alone; on an article the rule belongs under
 * the *tagline*, with the title and its provenance above it as one block. That
 * is a two-element arrangement, and one that is easy to get subtly wrong twice.
 */
export function ArticleHeading({
  title,
  tagline = articleTagline(),
}: {
  title: string;
  /** Overridden where the page is not an article — the editor says what a save does. */
  tagline?: string;
}) {
  return (
    <header className="mb-4">
      <h1 className="mb-0 border-b-0 pb-0">{title}</h1>
      <p className="border-b border-rule pb-2 text-caption text-ink-muted">
        {tagline}
      </p>
    </header>
  );
}
