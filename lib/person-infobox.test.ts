import { describe, expect, it } from "vitest";

import type {
  FamilyGraph,
  GraphChildLink,
  GraphPerson,
  GraphUnion,
} from "@/lib/family-graph";
import {
  derivePersonInfobox,
  type InfoboxPerson,
  infoboxEntrySlugs,
} from "@/lib/person-infobox";

/**
 * The infobox is derived from the tree, so what is worth asserting is the
 * derivation: which rows exist for a half-recorded life, what a stepchild is
 * when nothing records the word, and whether a date read off a headstone
 * survives the trip to the page as the year it actually was.
 *
 * `FamilyGraph` is imported with `import type` for the reason docs/testing.md
 * gives — `lib/family-graph.ts` reaches `@/db`, and `npm test` runs with no
 * `DATABASE_URL`. The type erases; the module is never loaded.
 *
 * The fixture is `db/seed.ts`'s family, which is the one the reference mockup
 * renders and was chosen because a naive model cannot represent it:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │              │
 *          Edward      Clara, Arthur     8 Shaws
 *
 * Rose has no recorded parents, which is the omit-the-row case; Edward is her
 * stepson through Thomas's earlier marriage, which is the derived one.
 */

function person(
  id: string,
  givenName: string,
  surname: string | null,
  overrides: Partial<GraphPerson> = {},
): GraphPerson {
  return {
    id,
    givenName,
    surname,
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathPlace: null,
    notes: null,
    pageId: null,
    ...overrides,
  };
}

function union(
  id: string,
  partnerAId: string | null,
  partnerBId: string | null,
  overrides: Partial<GraphUnion> = {},
): GraphUnion {
  return {
    id,
    partnerAId,
    partnerBId,
    type: "marriage",
    endReason: "ongoing",
    sequence: 0,
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    ...overrides,
  };
}

function childOf(
  unionId: string,
  childId: string,
  relation: GraphChildLink["relation"] = "biological",
): GraphChildLink {
  return { unionId, childId, relation };
}

const SHAW_NAMES = [
  ["ruth", "Ruth", 1949],
  ["harold", "Harold", 1950],
  ["doris", "Doris", 1952],
  ["frank", "Frank", 1954],
  ["vera", "Vera", 1955],
  ["leonard", "Leonard", 1957],
  ["joyce", "Joyce", 1959],
  ["stanley", "Stanley", 1961],
] as const;

/**
 * The seed tree from docs/architecture.md as a plain value.
 *
 * Related to `db/seed.ts` but deliberately not a transcription of it. Several
 * people here carry a `pageId`, because what this box does with a linked
 * relative — and with an unlinked one beside them — is the thing under test,
 * where the real seed writes a single entry, for Thomas. Which people those
 * are is answered by the `pageId` lines below and deliberately not restated
 * here: a count in a comment is a fact that drifts the first time somebody
 * adds a person, which is what this one had already done.
 */
function seedGraph(): FamilyGraph {
  return {
    people: [
      person("mary", "Mary", "Ellis", {
        birthDate: "1901-03-14",
        deathDate: "1931-08-02",
      }),
      person("thomas", "Thomas", "Hale", {
        pageId: "page-thomas",
        birthDate: "1898-11-20",
        deathDate: "1947-06-11",
      }),
      person("rose", "Rose", "Bennett", {
        pageId: "page-rose",
        birthDate: "1908-05-30",
        birthPlace: "Kilbride",
        deathDate: "1989-01-19",
        deathPlace: "Ardmore",
      }),
      person("walter", "Walter", "Shaw", {
        pageId: "page-walter",
        birthDate: "1905-09-08",
        birthDateQualifier: "about",
        birthDatePrecision: "year",
        deathDate: "1978-04-25",
      }),
      person("edward", "Edward", "Hale", {
        pageId: "page-edward",
        birthDate: "1929-01-01",
      }),
      person("clara", "Clara", "Hale", { birthDate: "1934-01-01" }),
      person("arthur", "Arthur", "Hale", { birthDate: "1936-01-01" }),
      ...SHAW_NAMES.map(([id, given, year]) =>
        person(id, given, "Shaw", { birthDate: `${year}-01-01` }),
      ),
    ],
    unions: [
      union("u1", "mary", "thomas", {
        sequence: 1,
        startDate: "1927-04-16",
        endDate: "1931-08-02",
        endReason: "death",
      }),
      union("u2", "rose", "thomas", {
        sequence: 2,
        startDate: "1933-02-11",
        endDate: "1947-06-11",
        endReason: "death",
      }),
      union("u3", "rose", "walter", {
        sequence: 3,
        startDate: "1948-07-03",
        startDateQualifier: "about",
      }),
    ],
    childLinks: [
      childOf("u1", "edward"),
      childOf("u2", "clara"),
      childOf("u2", "arthur"),
      ...SHAW_NAMES.map(([id]) => childOf("u3", id)),
    ],
  };
}

/** The entries that exist for the fixture above. */
const SLUGS = new Map([
  ["page-rose", "rose-bennett"],
  ["page-thomas", "thomas-hale"],
  ["page-walter", "walter-shaw"],
  ["page-edward", "edward-hale"],
]);

function boxFor(
  personId: string,
  graph: FamilyGraph = seedGraph(),
  slugs: ReadonlyMap<string, string> = SLUGS,
) {
  const box = derivePersonInfobox(graph, personId, slugs);
  if (!box) throw new Error(`no infobox for ${personId}`);
  return box;
}

const names = (people: InfoboxPerson[]) => people.map((one) => one.name);

describe("derivePersonInfobox", () => {
  it("is null for somebody the graph does not hold", () => {
    expect(derivePersonInfobox(seedGraph(), "nobody", SLUGS)).toBeNull();
  });

  it("states the birth and the death with their places", () => {
    const box = boxFor("rose");

    expect(box.name).toBe("Rose Bennett");
    expect(box.birth).toEqual({ date: "30 May 1908", place: "Kilbride" });
    expect(box.death).toEqual({ date: "19 January 1989", place: "Ardmore" });
  });
});

/**
 * The rule the ticket states twice: a row with no data is *absent*, not
 * "unknown" and not blank. Rose has no parents in the fixture, and in the
 * older generations of a real tree most people are missing most fields.
 */
describe("rows with nothing in them", () => {
  it("gives a person with no recorded parents an empty parents list", () => {
    expect(boxFor("rose").parents).toEqual([]);
  });

  it("gives a person with no relatives at all nothing to render", () => {
    const graph: FamilyGraph = {
      people: [person("alone", "Ada", "Quill")],
      unions: [],
      childLinks: [],
    };
    const box = boxFor("alone", graph);

    expect(box).toMatchObject({
      birth: null,
      death: null,
      spouses: [],
      children: [],
      stepchildren: [],
      parents: [],
    });
  });

  it("keeps a life event with only one half of it recorded", () => {
    const graph = seedGraph();
    graph.people = graph.people.map((one) =>
      one.id === "rose"
        ? { ...one, birthDate: null, deathPlace: null }
        : // A birth with a place but no date, and a death with a date but no
          // place, are both ordinary records rather than broken ones.
          one,
    );
    const box = boxFor("rose", graph);

    expect(box.birth).toEqual({ date: null, place: "Kilbride" });
    expect(box.death).toEqual({ date: "19 January 1989", place: null });
  });

  it("drops a union whose other partner nobody recorded", () => {
    // Both partner columns are nullable on purpose. A row whose whole job is
    // to name somebody has nothing to say when there is nobody to name.
    const graph = seedGraph();
    graph.unions = [union("u9", "rose", null, { startDate: "1930-01-01" })];
    graph.childLinks = [];

    expect(boxFor("rose", graph).spouses).toEqual([]);
  });
});

/**
 * Every fixture in this suite used to be day-precision, and that is how a
 * year read off a headstone shipped as "1 January 1890" once already. These
 * exercise the other two.
 */
describe("dates say only as much as the source did", () => {
  it("renders a year-precision birth as the year alone", () => {
    const graph = seedGraph();
    graph.people = graph.people.map((one) =>
      one.id === "rose"
        ? { ...one, birthDate: "1908-01-01", birthDatePrecision: "year" }
        : one,
    );

    expect(boxFor("rose", graph).birth?.date).toBe("1908");
  });

  it("renders a month-precision death as the month and the year", () => {
    const graph = seedGraph();
    graph.people = graph.people.map((one) =>
      one.id === "rose"
        ? { ...one, deathDate: "1989-01-19", deathDatePrecision: "month" }
        : one,
    );

    expect(boxFor("rose", graph).death?.date).toBe("January 1989");
  });

  it("keeps the qualifier, so 'about 1890' reads as 'about 1890'", () => {
    const graph = seedGraph();
    graph.people = graph.people.map((one) =>
      one.id === "rose"
        ? {
            ...one,
            birthDate: "1890-01-01",
            birthDateQualifier: "about",
            birthDatePrecision: "year",
          }
        : one,
    );

    expect(boxFor("rose", graph).birth?.date).toBe("about 1890");
  });
});

describe("spouses", () => {
  it("lists them in the order the marriages happened", () => {
    expect(names(boxFor("rose").spouses.map((s) => s.person))).toEqual([
      "Thomas Hale",
      "Walter Shaw",
    ]);
  });

  it("says when each union started and how it ended, in years", () => {
    const [thomas, walter] = boxFor("rose").spouses;

    expect(thomas.detail).toBe("m. 1933; died 1947");
    // Remembered as "about 1948", and it stays a guess on the page.
    expect(walter.detail).toBe("m. about 1948");
  });

  /**
   * Every way a union can have ended, rather than the two that happen to be
   * in the seed (`YEO-85`).
   *
   * This was one case asserting `divorce` under a name that promised a
   * separation as well, which is the failure mode the fixture rule is about
   * from its other side: `END_VERB` is a `Record` over the enum, so the
   * compiler guarantees every key *exists* and guarantees nothing about what
   * any of them says. `sep.` and `ended` were words no test had ever read
   * back. A table over the enum cannot fall behind it — adding a member to
   * `union_end_reason` fails to compile here until somebody says how it reads.
   */
  it.each([
    ["death", "died 1938"],
    ["divorce", "div. 1938"],
    ["separation", "sep. 1938"],
    ["unknown", "ended 1938"],
  ] as const)(
    "says how a union that ended in %s reads",
    (endReason, ending) => {
      const graph = seedGraph();
      graph.unions = [
        union("u1", "rose", "thomas", {
          startDate: "1933-02-11",
          endDate: "1938-05-02",
          endReason,
        }),
      ];

      expect(boxFor("rose", graph).spouses[0].detail).toBe(
        `m. 1933; ${ending}`,
      );
    },
  );

  /**
   * The same exhaustiveness for `UNION_PREFIX`. `marriage` is the column
   * default and `unknown` is what `validateUnion` settles on when a form says
   * nothing — so the value most likely to reach this function from a real
   * record was the one no fixture in the repository carried.
   */
  it.each([
    ["marriage", "m. 1933"],
    ["partnership", "from 1933"],
    ["unknown", "from 1933"],
  ] as const)("introduces the start year of a %s", (type, detail) => {
    const graph = seedGraph();
    graph.unions = [
      union("u1", "rose", "thomas", { type, startDate: "1933-02-11" }),
    ];

    expect(boxFor("rose", graph).spouses[0].detail).toBe(detail);
  });

  it("has nothing to say about a union nobody dated", () => {
    const graph = seedGraph();
    graph.unions = [union("u1", "rose", "thomas", { sequence: 1 })];

    expect(boxFor("rose", graph).spouses[0].detail).toBeNull();
  });

  it("gives no end clause to a union that is still going", () => {
    // `end_reason: ongoing` with an end date is contradictory data; the
    // ongoing flag wins, because "died 1978" is the louder claim.
    const graph = seedGraph();
    graph.unions = [
      union("u1", "rose", "thomas", {
        startDate: "1933-02-11",
        endDate: "1978-04-25",
        endReason: "ongoing",
      }),
    ];

    expect(boxFor("rose", graph).spouses[0].detail).toBe("m. 1933");
  });
});

describe("children", () => {
  it("lists them by the union they arrived through, then by birth", () => {
    expect(names(boxFor("rose").children)).toEqual([
      "Clara Hale",
      "Arthur Hale",
      "Ruth Shaw",
      "Harold Shaw",
      "Doris Shaw",
      "Frank Shaw",
      "Vera Shaw",
      "Leonard Shaw",
      "Joyce Shaw",
      "Stanley Shaw",
    ]);
  });

  it("counts a child of two of the subject's unions once", () => {
    const graph = seedGraph();
    graph.childLinks = [...graph.childLinks, childOf("u3", "clara", "adopted")];

    expect(
      names(boxFor("rose", graph).children).filter((n) => n === "Clara Hale"),
    ).toHaveLength(1);
  });
});

/**
 * The row nothing in the schema records. Edward belongs to Thomas's *first*
 * marriage and Rose to his second, and "stepchild" falls out of walking one
 * edge past the spouse. No author would maintain this by hand, and it changes
 * the moment somebody edits a union — which is the argument for the whole box.
 */
describe("stepchildren", () => {
  it("finds the child of a spouse's earlier marriage", () => {
    expect(names(boxFor("rose").stepchildren)).toEqual(["Edward Hale"]);
  });

  it("does not count the subject's own children among them", () => {
    const box = boxFor("rose");
    const own = new Set(box.children.map((child) => child.id));

    expect(box.stepchildren.filter((child) => own.has(child.id))).toEqual([]);
  });

  it("reads the same relationship from the other side", () => {
    // Thomas's own children are Edward, Clara and Arthur; the eight Shaws are
    // his second wife's children by her later marriage.
    const box = boxFor("thomas");

    expect(names(box.children)).toEqual([
      "Edward Hale",
      "Clara Hale",
      "Arthur Hale",
    ]);
    expect(names(box.stepchildren)).toEqual([
      "Ruth Shaw",
      "Harold Shaw",
      "Doris Shaw",
      "Frank Shaw",
      "Vera Shaw",
      "Leonard Shaw",
      "Joyce Shaw",
      "Stanley Shaw",
    ]);
  });

  it("gives a person whose spouse married nobody else none at all", () => {
    // Mary is not this case — her husband remarried, so Rose's children by him
    // are her stepchildren too, read from her side. This is the case where the
    // walk finds nothing and the row is therefore absent.
    const graph: FamilyGraph = {
      people: [
        person("ada", "Ada", "Quill"),
        person("bram", "Bram", "Quill"),
        person("cal", "Cal", "Quill", { birthDate: "1940-01-01" }),
      ],
      unions: [union("only", "ada", "bram", { sequence: 1 })],
      childLinks: [childOf("only", "cal")],
    };
    const box = boxFor("ada", graph);

    expect(names(box.children)).toEqual(["Cal Quill"]);
    expect(box.stepchildren).toEqual([]);
  });

  it("keeps two spouses' earlier families apart rather than interleaving them", () => {
    // Both of the subject's spouses brought children from an earlier
    // marriage. Grouped by the spouse they come through, in spouse order —
    // the same rule the Children row follows one hop closer in. A flat sort
    // by birth date would read as one blended family that never existed.
    const graph: FamilyGraph = {
      people: [
        person("subject", "Rose", "Bennett"),
        person("first", "Thomas", "Hale"),
        person("second", "Walter", "Shaw"),
        person("earlier-a", "Mary", "Ellis"),
        person("earlier-b", "Ada", "Quill"),
        person("edward", "Edward", "Hale", { birthDate: "1929-01-01" }),
        person("nell", "Nell", "Shaw", { birthDate: "1927-01-01" }),
      ],
      unions: [
        union("own-1", "subject", "first", { sequence: 2 }),
        union("own-2", "subject", "second", { sequence: 3 }),
        union("his-earlier", "earlier-a", "first", { sequence: 1 }),
        union("her-earlier", "earlier-b", "second", { sequence: 1 }),
      ],
      childLinks: [
        childOf("his-earlier", "edward"),
        childOf("her-earlier", "nell"),
      ],
    };

    // Nell is the older of the two, so birth order alone would put her first.
    expect(names(boxFor("subject", graph).stepchildren)).toEqual([
      "Edward Hale",
      "Nell Shaw",
    ]);
  });

  it("orders one spouse's earlier families by when they happened", () => {
    const graph: FamilyGraph = {
      people: [
        person("subject", "Rose", "Bennett"),
        person("spouse", "Thomas", "Hale"),
        person("first-wife", "Mary", "Ellis"),
        person("second-wife", "Ada", "Quill"),
        person("older", "Edward", "Hale", { birthDate: "1929-01-01" }),
        person("younger", "Nell", "Hale", { birthDate: "1925-01-01" }),
      ],
      unions: [
        union("own", "subject", "spouse", { sequence: 3 }),
        union("his-first", "first-wife", "spouse", { sequence: 1 }),
        union("his-second", "second-wife", "spouse", { sequence: 2 }),
      ],
      childLinks: [
        childOf("his-second", "younger"),
        childOf("his-first", "older"),
      ],
    };

    // Nell was born first, but she belongs to the later marriage.
    expect(names(boxFor("subject", graph).stepchildren)).toEqual([
      "Edward Hale",
      "Nell Hale",
    ]);
  });

  it("names a stepchild once when two of a spouse's unions reach them", () => {
    const graph: FamilyGraph = {
      people: [
        person("subject", "Rose", "Bennett"),
        person("spouse", "Thomas", "Hale"),
        person("edward", "Edward", "Hale", { birthDate: "1929-01-01" }),
      ],
      unions: [
        union("own", "subject", "spouse", { sequence: 2 }),
        union("his-first", null, "spouse", { sequence: 1 }),
        union("his-third", null, "spouse", { sequence: 3 }),
      ],
      childLinks: [
        childOf("his-first", "edward"),
        childOf("his-third", "edward", "adopted"),
      ],
    };

    expect(names(boxFor("subject", graph).stepchildren)).toEqual([
      "Edward Hale",
    ]);
  });

  it("takes a child link recorded as `step` at its word", () => {
    // The author said so on the link itself, so it belongs in the same row as
    // the derived ones rather than in a second idea spelled the same way.
    const graph = seedGraph();
    graph.childLinks = graph.childLinks.map((link) =>
      link.childId === "clara" ? { ...link, relation: "step" as const } : link,
    );
    const box = boxFor("rose", graph);

    expect(names(box.children)).not.toContain("Clara Hale");
    expect(names(box.stepchildren)).toContain("Clara Hale");
  });

  it("never lists the subject as their own stepchild", () => {
    // A child of one of a spouse's other unions who is also the subject is
    // impossible data, and the box should not repeat it back as a fact.
    const graph = seedGraph();
    graph.childLinks = [...graph.childLinks, childOf("u1", "rose")];

    expect(names(boxFor("rose", graph).stepchildren)).not.toContain(
      "Rose Bennett",
    );
  });
});

describe("parents", () => {
  it("names both partners of the union the subject was born into", () => {
    expect(names(boxFor("edward").parents)).toEqual([
      "Mary Ellis",
      "Thomas Hale",
    ]);
  });

  it("names a parent once when two links reach them", () => {
    // Born into one union and adopted into another by the same person: two
    // rows in `union_children`, one parent.
    const graph = seedGraph();
    graph.unions = [
      ...graph.unions,
      union("u4", "thomas", null, { sequence: 4 }),
    ];
    graph.childLinks = [
      ...graph.childLinks,
      childOf("u4", "edward", "adopted"),
    ];

    expect(names(boxFor("edward", graph).parents)).toEqual([
      "Mary Ellis",
      "Thomas Hale",
    ]);
  });
});

describe("the links it wants resolved", () => {
  it("collects every entry it names, each once", () => {
    // Rose's box names Thomas, Walter, ten children and Edward. Only the ones
    // with an entry have a slug to ask about.
    expect(infoboxEntrySlugs(boxFor("rose"))).toEqual(
      new Set(["thomas-hale", "walter-shaw", "edward-hale"]),
    );
  });

  it("leaves a person with no entry without a slug, which is the red link", () => {
    const clara = boxFor("rose").children.find(
      (child) => child.name === "Clara Hale",
    );

    expect(clara?.slug).toBeNull();
  });

  it("does not ask about the subject's own entry", () => {
    // The box is on that entry already; linking a page to itself is noise.
    expect(infoboxEntrySlugs(boxFor("rose")).has("rose-bennett")).toBe(false);
  });

  it("treats a page id with no slug as no entry rather than as a broken one", () => {
    expect(infoboxEntrySlugs(boxFor("rose", seedGraph(), new Map())).size).toBe(
      0,
    );
  });

  it("asks for nothing when the entry is not about a person", () => {
    expect(infoboxEntrySlugs(null)).toEqual(new Set());
    expect(infoboxEntrySlugs(undefined)).toEqual(new Set());
  });
});
