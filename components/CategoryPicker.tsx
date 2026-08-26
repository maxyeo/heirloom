"use client";

import { useMemo, useState } from "react";

import {
  categorySlug,
  compareCategoriesByName,
  MAX_CATEGORIES_PER_ENTRY,
  MAX_CATEGORY_NAME_LENGTH,
  type NamedCategory,
  normaliseCategoryName,
} from "@/lib/category-name";

/**
 * Filing an entry from the editor (E11-T8, `YEO-78`).
 *
 * ## Why choosing and creating are one control
 *
 * The ticket asks for "a picker over existing categories, creating new ones
 * inline", and it is the same argument `PartnerPicker` makes about people: the
 * alternative is a picker that only finds categories and a separate page to
 * visit when it does not, and the author who needs that detour is halfway
 * through writing an entry. A family wiki's categories are mostly *invented
 * while filing something* — "Emigrated to Canada" exists because somebody was
 * writing about the first person who did.
 *
 * So the "not there yet" answer sits under the list, carrying what was typed,
 * and pressing Enter takes it. The row only appears when the typed name is not
 * already one of the categories offered, because unlike a person, two
 * categories with the same name are never two different things — the slug says
 * so (`lib/category-name.ts`).
 *
 * ## Why this is not `[[Category:…]]`
 *
 * Explicitly ruled out by the ticket, and `db/schema.ts` has the long form of
 * why. The short form: this wiki has no wikitext, and a syntax nobody types is
 * a syntax nobody uses.
 *
 * ## Why it holds no form field and imports no action
 *
 * It reports a list and renders nothing the form posts, exactly as
 * `PartnerPicker` does. That is what lets it be mounted in a test with no
 * server action, no `useActionState` and therefore no `@/db` anywhere in its
 * import graph — docs/testing.md's "a Client Component that a test may want to
 * mount should take its action, not import it", and the rule that `npm test`
 * must never need a database.
 *
 * Everything it decides about a name — what it normalises to, whether two
 * names are one category, whether a name can have an address at all — is the
 * same function the server applies on the way in. Not because the field is a
 * boundary (it is not; `savePageAction` re-does all of it), but because a
 * picker that let an author add two chips the server would then silently merge
 * would be lying to them about what they had just done.
 */
export interface CategoryPickerProps {
  /** What the entry is filed under right now, in the author's order. */
  value: readonly NamedCategory[];
  /**
   * Every category that already exists, alphabetically.
   *
   * Filtered in the browser as the author types. There is nothing to debounce
   * against and no request to make: a family wiki has fewer categories than
   * entries, `app/wiki/[slug]/edit/page.tsx` already reads them on the server,
   * and a keystroke costs one pass over an array — the same shape, and the
   * same reasoning, as `PartnerPicker` over the tree the canvas already holds.
   */
  existing: readonly NamedCategory[];
  /** Called with the new filing whenever the author adds or removes one. */
  onChange: (categories: readonly NamedCategory[]) => void;
  /** So the caller's `<label>` can point at the input. */
  inputId?: string;
  /** The id of a hint to announce with the field, when there is one. */
  describedBy?: string;
}

export function CategoryPicker({
  value,
  existing,
  onChange,
  inputId,
  describedBy,
}: CategoryPickerProps) {
  const [query, setQuery] = useState("");

  const full = value.length >= MAX_CATEGORIES_PER_ENTRY;

  /**
   * The name as it would be stored, and the address it would live at.
   *
   * `null` for a name that cannot have an address — one made entirely of
   * punctuation or emoji. `categorySlug` explains why that is refused here
   * rather than given the fallback an entry title gets; what matters at this
   * end is that the author is not offered an "Add" that would file the entry
   * under something they did not name.
   */
  const typedName = normaliseCategoryName(query);
  const typedSlug = typedName === "" ? null : categorySlug(typedName);

  const chosen = useMemo(
    () => new Set(value.map((category) => category.slug)),
    [value],
  );

  /**
   * What to offer: the categories that exist, minus the ones this entry
   * already carries, narrowed by what has been typed.
   *
   * A plain case-insensitive substring match rather than the ranked search
   * `lib/partner-search.ts` performs. A category name is a short label an
   * author is trying to *re-find*, not a person they are trying to identify
   * among namesakes — "canada" should surface "Emigrated to Canada", and there
   * is nothing further to rank once it has.
   */
  const suggestions = useMemo(() => {
    const needle = typedName.toLowerCase();
    return existing
      .filter(
        (category) =>
          !chosen.has(category.slug) &&
          (needle === "" || category.name.toLowerCase().includes(needle)),
      )
      .slice()
      .sort(compareCategoriesByName);
  }, [existing, chosen, typedName]);

  /**
   * Whether the typed name would be a *new* category rather than one of the
   * suggestions above.
   *
   * Compared on the slug, not on the text, so typing "whitfield family" when
   * "Whitfield family" exists offers the existing one and no invitation to
   * create — which is true, and is what the unique index would enforce a
   * moment later anyway.
   */
  const creatable =
    typedSlug !== null &&
    !chosen.has(typedSlug) &&
    !existing.some((category) => category.slug === typedSlug);

  function add(category: NamedCategory): void {
    setQuery("");
    if (full || chosen.has(category.slug)) return;
    onChange([...value, category]);
  }

  function remove(slug: string): void {
    onChange(value.filter((category) => category.slug !== slug));
  }

  return (
    <div>
      {/*
        What the entry is filed under, above the field rather than below it:
        this is the answer, and the field is the way to change it. A list with
        `role="list"` restored, because Tailwind preflight strips the markers
        and Safari/VoiceOver drops a list's semantics when it sees that — the
        same note `app/wiki/page.tsx` carries for the index.
      */}
      {value.length === 0 ? (
        <p className="text-note text-ink-muted">
          This entry is not filed under any category yet.
        </p>
      ) : (
        <ul role="list" className="flex flex-wrap gap-1.5">
          {value.map((category) => (
            <li
              key={category.slug}
              className="flex items-center gap-1 rounded-panel border border-rule-soft bg-panel px-2 py-0.5"
            >
              <span>{category.name}</span>
              <button
                type="button"
                onClick={() => remove(category.slug)}
                // Said in full for a screen reader, which meets this button
                // with no column position and no chip beside it to read from.
                aria-label={`Remove the category ${category.name}`}
                className="text-note text-link hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {full ? (
        // Reachable only by someone determined to get here — see
        // `MAX_CATEGORIES_PER_ENTRY`. Said plainly rather than by a field that
        // silently stops working.
        <p className="mt-2 text-note text-ink-muted">
          This entry is filed under the most categories one entry can carry.
        </p>
      ) : (
        <>
          <input
            id={inputId}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter files under whatever is typed, which is the whole point
              // of an inline create. `preventDefault` because this control
              // lives inside the editor's form, and the browser's default for
              // Enter in a text input there is to submit it — saving the entry
              // instead of adding the category.
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (typedSlug === null) return;
              const existingMatch = existing.find(
                (category) => category.slug === typedSlug,
              );
              add(existingMatch ?? { name: typedName, slug: typedSlug });
            }}
            placeholder="Search or type a new category"
            maxLength={MAX_CATEGORY_NAME_LENGTH}
            // Off: the browser's own history of what has been typed into a
            // field called "category" is noise over the list underneath it.
            autoComplete="off"
            aria-describedby={describedBy}
            className="mt-2 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
          />

          {suggestions.length === 0 && !creatable ? null : (
            <ul
              aria-label="Matching categories"
              className="mt-1 max-h-40 overflow-y-auto rounded-panel border border-rule-soft"
            >
              {suggestions.map((category) => (
                <li key={category.slug}>
                  <button
                    type="button"
                    onClick={() => add(category)}
                    className="block w-full px-2 py-1.5 text-left hover:bg-wash"
                  >
                    {category.name}
                  </button>
                </li>
              ))}

              {/*
                The inline create, under the matches rather than instead of
                them — and only when what was typed is genuinely not one of
                them. Unlike `PartnerPicker`, which offers to create a person
                whatever it found: two people can share a name and two
                categories cannot.
              */}
              {creatable && typedSlug !== null ? (
                <li>
                  <button
                    type="button"
                    onClick={() => add({ name: typedName, slug: typedSlug })}
                    className="block w-full px-2 py-1.5 text-left hover:bg-wash"
                  >
                    Create the category “{typedName}”
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
