import Link from "next/link";

import {
  changeWhenIso,
  formatChangeAuthor,
  formatChangeWhen,
  formatImportFileName,
  formatPersonCount,
  type RecentChange,
} from "@/lib/recent-changes-feed";
import { treeHref } from "@/lib/tree-selection";

/**
 * The home page's "Recently changed" section as markup (E8-T4, `YEO-58`),
 * taking its rows as a prop.
 *
 * Split from `components/RecentChanges.tsx` — the ten lines that fetch — for
 * the reason `components/EntrySearchResults.tsx` and
 * `components/PersonSearchResults.tsx` were split from `app/search/page.tsx`:
 * an `async` Server Component cannot be mounted by React or Vitest at all
 * (docs/testing.md), so everything worth asserting about what a feed row
 * *looks like* has to live in a plain synchronous component. Here that is
 * most of the ticket's acceptance criteria — that a row says who, what and
 * when, and that a person's arrival is reported alongside an entry's edit —
 * which `components/RecentChangesList.test.tsx` can then check as markup
 * rather than as a promise nobody can await.
 *
 * It renders the whole section, heading and empty state included, rather than
 * only the `<ul>`. The wrapper is then genuinely nothing but a `await`, and
 * the heading — which is part of what the section *says* — is inside the half
 * a test can see.
 */
export function RecentChangesList({
  changes,
}: {
  changes: readonly RecentChange[];
}) {
  return (
    <section className="mt-8">
      {/* `h2` outside `.wiki-body`: this is a section of the home page rather
          than a heading within an article, and `globals.css` styles article
          headings only inside that class. The Browse block above it makes the
          same choice from the other direction — it *is* prose, so it wears
          `.wiki-body`. */}
      <h2 className="mb-1 border-b border-rule pb-1 text-lg">
        Recently changed
      </h2>

      {changes.length === 0 ? (
        /*
          A wiki with nothing in it yet, which is the state every install
          starts in — the same first-run case `app/wiki/page.tsx` answers with
          an invitation rather than with "0 results". No link here, though:
          the Browse block directly above already offers both doors, and a
          third copy of "create the first entry" on one short page would be
          noise.
        */
        <p className="text-caption text-ink-muted">
          Nothing has been written yet. Changes to entries, and people added to
          the family tree, will appear here.
        </p>
      ) : (
        <>
          <p className="text-caption text-ink-muted">
            What the family has been writing lately.
          </p>

          {/* `role="list"` restores what Tailwind's preflight takes away:
              stripping the markers also drops the list's implicit semantics in
              Safari and VoiceOver, which then announce a run of links instead
              of "list, N items". Established by `app/wiki/page.tsx`. */}
          <ul role="list" className="mt-3">
            {changes.map((change) => (
              <li
                key={changeKey(change)}
                className="border-b border-rule-soft py-1.5"
              >
                <RecentChangeRow change={change} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A stable React key for one row.
 *
 * Not the array index, and not `when`: the index reorders under the reader on
 * the next render, and two changes can share an instant (see
 * `mergeRecentChanges`). The arm's own identity is unique within its table,
 * and the `kind` prefix makes it unique across the three — a person id and an
 * import id are both UUIDs and could otherwise collide in principle.
 */
function changeKey(change: RecentChange): string {
  switch (change.kind) {
    case "entry-changed":
      return `entry-changed:${change.slug}`;
    case "person-added":
      return `person-added:${change.personId}`;
    case "people-imported":
      return `people-imported:${change.importId}`;
  }
}

/**
 * One row: what changed, then who and when under it.
 *
 * A `switch` over the discriminated union rather than one row shape with
 * conditional fields, which is the whole point of the union reaching this far
 * — the compiler checks that every arm is rendered, and a fourth arm added to
 * `RecentChange` later is a type error here rather than a row that silently
 * renders blank. The three arms genuinely differ: two of them link somewhere
 * and one does not, and only two of them can name a person.
 */
function RecentChangeRow({ change }: { change: RecentChange }) {
  switch (change.kind) {
    case "entry-changed":
      return (
        <>
          {/* `encodeURIComponent` rather than the raw slug, for the reason
              `app/wiki/page.tsx` spells out: the column is `text`, so nothing
              in the schema stops a slug holding a `?`, a `#` or a space, any
              of which would truncate or re-point the href. */}
          <Link href={`/wiki/${encodeURIComponent(change.slug)}`}>
            {change.title}
          </Link>
          <ChangeByline
            what="edited by"
            who={formatChangeAuthor(change.editor)}
            when={change.when}
          />
        </>
      );

    case "person-added":
      return (
        <>
          {/* Through `treeHref`, so there is one place that knows the shape of
              the `?person=` deep link — the same route
              `components/PersonSearchResults.tsx` sends a search result to. A
              person's own entry would be the other candidate, but not every
              person has one, and the tree is where a person always exists. */}
          <Link href={treeHref(change.personId)}>{change.name}</Link>
          {/*
            No author, because `individuals` records none — see the
            `person-added` arm of `RecentChange`. The byline says what the
            change *was* instead, which is the honest half of "who changed
            what and when" that this source can answer.
          */}
          <ChangeByline what="added to the family tree" when={change.when} />
        </>
      );

    case "people-imported":
      return (
        <>
          {/* Not a link: there is no page that shows one import. The file's
              name is the identity a reader recognises, so it is the emphasis
              rather than an anchor. */}
          <span className="font-semibold">
            {formatPersonCount(change.personCount)} imported from{" "}
            {formatImportFileName(change.fileName)}
          </span>
          <ChangeByline
            what="imported by"
            who={formatChangeAuthor(change.importedBy)}
            when={change.when}
          />
        </>
      );
  }
}

/**
 * The muted second line every row ends with: what happened, by whom where
 * that is recorded, and when.
 *
 * One component so the three arms cannot drift into three different ways of
 * saying the same thing, and so the `<time>` element's two halves — the
 * machine-readable instant and the string a reader sees — are produced
 * together in one place.
 *
 * `who` is optional rather than nullable-and-rendered-as-"Unknown": a caller
 * that has no author column to read must not be able to accidentally claim
 * the author is unknown, which is the distinction `RecentChange` is a
 * discriminated union to preserve. `formatChangeAuthor` is what turns a null
 * column into "Unknown", and only the two arms that *have* that column call it.
 */
function ChangeByline({
  what,
  who,
  when,
}: {
  what: string;
  who?: string;
  when: Date;
}) {
  return (
    <p className="text-note text-ink-muted">
      {who === undefined ? what : `${what} ${who}`}
      {" · "}
      <time dateTime={changeWhenIso(when)}>{formatChangeWhen(when)}</time>
    </p>
  );
}
