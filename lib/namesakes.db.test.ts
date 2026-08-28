import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { NAMESAKE_LIMIT } from "@/lib/hatnote";
import { findNamesakes } from "@/lib/namesakes";
import { addedByHand } from "@/test/people-fixtures";

/**
 * Database tests for the name-collision lookup behind the automatic hatnote
 * (E11-T9, `YEO-79`). Run with `npm run test:db`; the `.db.test.ts` suffix is
 * what keeps them out of `npm test` and CI's bare environment. See
 * docs/testing.md.
 *
 * Everything asserted here lives in SQL rather than in TypeScript: the
 * predicate on `(surname, given_name)` that `individuals_surname_idx` serves,
 * the `IS NULL` branch for a person with no recorded surname, the `left join`
 * that fetches entry addresses without a query per name, and the `order by`
 * that makes the answer the same on every run. A mocked database would only
 * assert that the mock returns what the mock was told to return.
 *
 * Fixed, recognisable ids so teardown deletes exactly what this file created.
 */

const PREFIX = "namesake-fixture";
/** Unique to this file, so a real "Rose" in the developer's data cannot join in. */
const GIVEN = `${PREFIX} Rose`;
const SURNAME = `${PREFIX} Whitfield`;

const id = (n: number) =>
  `00000000-0000-4000-8000-0000e79${n.toString(16).padStart(5, "0")}`;

const SUBJECT = id(1);
const ELDER = id(2);
const YOUNGER = id(3);
const UNDATED = id(4);
const DIFFERENT_SURNAME = id(5);
const NO_SURNAME_SUBJECT = id(6);
const NO_SURNAME_OTHER = id(7);
const CLAIMS_SUBJECT_PAGE = id(8);

const SUBJECT_PAGE = id(0xa1);
const ELDER_PAGE = id(0xa2);

const PEOPLE = [
  SUBJECT,
  ELDER,
  YOUNGER,
  UNDATED,
  DIFFERENT_SURNAME,
  NO_SURNAME_SUBJECT,
  NO_SURNAME_OTHER,
  CLAIMS_SUBJECT_PAGE,
];
const PAGES = [SUBJECT_PAGE, ELDER_PAGE];

/** People first: `page_id` is `on delete set null`, not a cascade either way. */
async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  await db.delete(schema.pages).where(inArray(schema.pages.id, PAGES));
}

beforeEach(async () => {
  await removeFixture();

  await db.insert(schema.pages).values([
    { id: SUBJECT_PAGE, slug: `${PREFIX}-subject`, title: `${PREFIX} subject` },
    { id: ELDER_PAGE, slug: `${PREFIX}-elder`, title: `${PREFIX} elder` },
  ]);

  await db.insert(schema.individuals).values(
    addedByHand([
      {
        id: SUBJECT,
        pageId: SUBJECT_PAGE,
        givenName: GIVEN,
        surname: SURNAME,
        birthDate: "1921-01-01",
      },
      {
        id: ELDER,
        pageId: ELDER_PAGE,
        givenName: GIVEN,
        surname: SURNAME,
        birthDate: "1890-01-01",
        deathDate: "1962-01-01",
      },
      // No entry of her own: the case the `left join` exists for.
      {
        id: YOUNGER,
        givenName: GIVEN,
        surname: SURNAME,
        birthDate: "1948-01-01",
        birthDateQualifier: "about",
      },
      { id: UNDATED, givenName: GIVEN, surname: SURNAME },
      { id: DIFFERENT_SURNAME, givenName: GIVEN, surname: `${SURNAME} Hale` },
      { id: NO_SURNAME_SUBJECT, givenName: `${PREFIX} Mary`, surname: null },
      { id: NO_SURNAME_OTHER, givenName: `${PREFIX} Mary`, surname: null },
    ]),
  );
});

afterAll(removeFixture);

const subject = {
  id: SUBJECT,
  givenName: GIVEN,
  surname: SURNAME as string | null,
};

describe("findNamesakes", () => {
  it("finds everybody with the same full name, and nobody else", async () => {
    const { people, extra } = await findNamesakes(subject, SUBJECT_PAGE);

    expect(people.map((person) => person.id)).toEqual([
      // Oldest first; the undated person comes last because Postgres sorts
      // nulls last on an ascending order.
      ELDER,
      YOUNGER,
      UNDATED,
    ]);
    expect(extra).toBe(0);
  });

  it("does not report the subject as their own namesake", async () => {
    const { people } = await findNamesakes(subject, SUBJECT_PAGE);
    expect(people.map((person) => person.id)).not.toContain(SUBJECT);
  });

  it("brings each namesake's entry address back in the same query", async () => {
    const { people } = await findNamesakes(subject, SUBJECT_PAGE);

    const bySlug = Object.fromEntries(
      people.map((person) => [person.id, person.slug]),
    );
    expect(bySlug[ELDER]).toBe(`${PREFIX}-elder`);
    // Nobody has written about her, so there is no address to have been
    // written down — which the hatnote renders as a red link.
    expect(bySlug[YOUNGER]).toBeNull();
  });

  it("keeps a namesake whose entry has been retired, without the address", async () => {
    /**
     * E1-T10 (`YEO-122`), and the shape of the answer is the whole assertion.
     *
     * The hatnote is a claim about *people*: "for other people named Rose
     * Whitfield" is still true of a Rose whose entry somebody retired, so she
     * must go on being named. What she loses is the link — and she loses it by
     * arriving in exactly the shape a namesake nobody has written about
     * arrives in, a name with a null slug, which `lib/hatnote.ts` already
     * knows how to render.
     *
     * This is also the regression guard for the `ON`-versus-`WHERE` trap that
     * `lib/namesakes.ts` documents. The predicate lives in the `left join`'s
     * `ON` clause; written into the `WHERE` the *elder* would vanish from the
     * result entirely rather than merely losing her address. So both halves of
     * her are asserted: she is still there, and her slug is null.
     */
    await db
      .update(schema.pages)
      .set({ deletedAt: new Date(), deletedBy: "rose@example.com" })
      .where(eq(schema.pages.id, ELDER_PAGE));

    const { people } = await findNamesakes(subject, SUBJECT_PAGE);
    const elder = people.find((person) => person.id === ELDER);

    expect(elder).toBeDefined();
    expect(elder?.slug).toBeNull();

    // And the namesake nobody has written about arrives exactly as she always
    // did. She is not what discriminates the two placements: `deleted_at is
    // null` is true of the all-null row a join miss produces, so a `WHERE`
    // would leave her alone. The one a `WHERE` takes down is the retired
    // namesake, which is what the two assertions above are for. This one pins
    // the shape those two are comparing her against — a name with a null slug,
    // reached by two different routes and rendered the same way.
    expect(people.map((person) => person.id)).toContain(YOUNGER);
  });

  it("carries the dates the line needs to tell them apart", async () => {
    const { people } = await findNamesakes(subject, SUBJECT_PAGE);
    const elder = people.find((person) => person.id === ELDER);

    expect(elder?.birthDate).toBe("1890-01-01");
    expect(elder?.deathDate).toBe("1962-01-01");
    expect(
      people.find((person) => person.id === YOUNGER)?.birthDateQualifier,
    ).toBe("about");
  });

  it("matches a missing surname against a missing surname, not against none", async () => {
    // `surname = NULL` is never true, so the `IS NULL` branch is the whole of
    // whether two undocumented Marys count as a collision. They do.
    const { people } = await findNamesakes(
      { id: NO_SURNAME_SUBJECT, givenName: `${PREFIX} Mary`, surname: null },
      SUBJECT_PAGE,
    );

    expect(people.map((person) => person.id)).toEqual([NO_SURNAME_OTHER]);
  });

  it("answers nothing for a name nobody shares", async () => {
    const { people, extra } = await findNamesakes(
      { id: DIFFERENT_SURNAME, givenName: GIVEN, surname: `${SURNAME} Hale` },
      SUBJECT_PAGE,
    );

    expect(people).toEqual([]);
    expect(extra).toBe(0);
  });

  it("ignores a second row claiming this very entry", async () => {
    // Only reachable through a hand-run `UPDATE`, and the failure it would
    // produce is a hatnote sending the reader to the page they are on.
    await db.insert(schema.individuals).values(
      addedByHand([
        {
          id: CLAIMS_SUBJECT_PAGE,
          pageId: SUBJECT_PAGE,
          givenName: GIVEN,
          surname: SURNAME,
        },
      ]),
    );

    const { people } = await findNamesakes(subject, SUBJECT_PAGE);
    expect(people.map((person) => person.id)).not.toContain(
      CLAIMS_SUBJECT_PAGE,
    );
  });

  it("names at most NAMESAKE_LIMIT of them and counts the rest", async () => {
    // One more than the cap, so the count has something to say.
    const overflow = Array.from({ length: NAMESAKE_LIMIT }, (_unused, index) =>
      id(0xb0 + index),
    );
    await db.insert(schema.individuals).values(
      addedByHand(
        overflow.map((personId, index) => ({
          id: personId,
          givenName: GIVEN,
          surname: SURNAME,
          birthDate: `19${(70 + index).toString()}-01-01`,
        })),
      ),
    );

    try {
      const { people, extra } = await findNamesakes(subject, SUBJECT_PAGE);
      expect(people).toHaveLength(NAMESAKE_LIMIT);
      // Three from the base fixture plus five more, less the five named.
      expect(extra).toBe(3);
    } finally {
      await db
        .delete(schema.individuals)
        .where(inArray(schema.individuals.id, overflow));
    }
  });
});
