import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { seedFamily } from "@/db/seed-family";
import type { ChildRelation } from "@/lib/child-input";
import {
  type ExportChild,
  type ExportIndividual,
  type ExportUnion,
  type GedcomExportInput,
  writeGedcom,
} from "@/lib/gedcom-export";
import { roundTripBytes } from "@/test/gedcom-round-trip";

/**
 * The files a Gramps run reads (`YEO-91`).
 *
 * Four exports rather than one, because "an export opens in Gramps" is a
 * claim about everything this application can write, and the cheapest way to
 * make that claim false is to check a file with nothing awkward in it.
 *
 * They are **built, not committed**. Every one of them is a function of code
 * in this repository — the seed family, the fixtures, and the serialiser — so
 * a copy on disk would be a fifth thing to keep in step with the four, and
 * would go stale the first time the exporter changed without anybody
 * re-running Gramps. `test/gramps/README.md` records what Gramps said about
 * the files this function produced on the day it was run, which is the part
 * that cannot be re-derived.
 *
 * Nothing here reaches a database: `db/seed-family.ts` is plain values, for
 * the reason its own docblock gives.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/gedcom/", import.meta.url));

/** A uuid-shaped id, since the export takes the database's own row types. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A person with everything unrecorded, to be spread over. */
function person(
  n: number,
  overrides: Partial<ExportIndividual> = {},
): ExportIndividual {
  return {
    id: id(n),
    givenName: "Ada",
    surname: "Smith",
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthDateUpper: null,
    birthDateUpperPrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathDateUpper: null,
    deathDateUpperPrecision: "day",
    deathPlace: null,
    notes: null,
    portraitKey: null,
    portraitThumbKey: null,
    ...overrides,
  };
}

/** A union with everything unrecorded, to be spread over. */
function union(n: number, overrides: Partial<ExportUnion> = {}): ExportUnion {
  return {
    id: id(n),
    partnerAId: null,
    partnerBId: null,
    type: "unknown",
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    startDateUpper: null,
    startDateUpperPrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    endDateUpper: null,
    endDateUpperPrecision: "day",
    endReason: "ongoing",
    sequence: 0,
    notes: null,
    ...overrides,
  };
}

function childOf(
  parents: ExportUnion,
  child: ExportIndividual,
  relation: ChildRelation,
): ExportChild {
  return { unionId: parents.id, childId: child.id, relation };
}

/** The seeded family — the remarriage chain, exactly as `db/seed.ts` writes it. */
const seeded: GedcomExportInput = {
  individuals: seedFamily.people,
  unions: seedFamily.unions,
  unionChildren: seedFamily.childLinks,
};

/**
 * One tree carrying every value the exporter can write.
 *
 * The seeded family is the *shape* that matters and it is not the *vocabulary*
 * that matters: it has no `step` or `foster` child, no `X` sex, no range, no
 * divorce, and no accented name. Those are where a strict reader is most
 * likely to differ from a permissive one, and two of them — `PEDI step` and
 * the UTF-8 in a `NAME` — are the departures from 5.5.1 that
 * `docs/gedcom.md` records as deliberate. A run that never wrote them would
 * not have checked the thing the ticket was raised to check.
 */
function everyForm(): GedcomExportInput {
  const ada = person(1, { givenName: "Ada", sex: "female" });
  const bertrand = person(2, { givenName: "Bertrand", sex: "male" });
  const cecile = person(3, {
    givenName: "Cécile",
    surname: "Ó Braonáin",
    sex: "other",
  });
  const dara = person(4, { givenName: "Dara", surname: null });

  const biological = person(5, {
    givenName: "Biological",
    birthDate: "1901-02-03",
    birthPlace: "Whitby, Yorkshire",
    deathDate: "1980-12-31",
    deathPlace: "Whitby, Yorkshire",
  });
  const adopted = person(6, {
    givenName: "Adopted",
    birthDate: "1903-01-01",
    birthDateQualifier: "about",
    birthDatePrecision: "year",
  });
  const step = person(7, {
    givenName: "Step",
    birthDate: "1905-06-01",
    birthDateQualifier: "before",
    birthDatePrecision: "month",
  });
  const foster = person(8, {
    givenName: "Foster",
    birthDate: "1907-01-01",
    birthDateQualifier: "after",
    birthDatePrecision: "year",
    // A range: `BET 1970 AND 1975`. The upper bound is what makes it one —
    // there is no `between` qualifier, for the reason `lib/field-input.ts`
    // gives.
    deathDate: "1970-01-01",
    deathDatePrecision: "year",
    deathDateUpper: "1975-01-01",
    deathDateUpperPrecision: "year",
  });

  const married = union(20, {
    partnerAId: ada.id,
    partnerBId: bertrand.id,
    type: "marriage",
    startDate: "1900-04-16",
    endDate: "1931-08-02",
    endReason: "death",
  });

  // A partnership that ended in divorce, which is the pair `docs/gedcom.md`
  // says GEDCOM cannot hold and the export writes as `MARR Y` beside `DIV`.
  const divorced = union(21, {
    partnerAId: bertrand.id,
    partnerBId: cecile.id,
    type: "partnership",
    startDate: "1935-01-01",
    startDatePrecision: "year",
    startDateUpper: "1937-01-01",
    startDateUpperPrecision: "year",
    endDate: "1940-06-01",
    endDatePrecision: "month",
    endReason: "divorce",
    sequence: 1,
  });

  // One partner recorded and the other not — the case `db/schema.ts` calls
  // extremely common, and a `FAM` with a single `HUSB` in the file.
  const halfKnown = union(22, {
    partnerAId: dara.id,
    type: "unknown",
    sequence: 2,
  });

  return {
    individuals: [
      ada,
      bertrand,
      cecile,
      dara,
      biological,
      adopted,
      step,
      foster,
    ],
    unions: [married, divorced, halfKnown],
    unionChildren: [
      childOf(married, biological, "biological"),
      childOf(married, adopted, "adopted"),
      childOf(divorced, step, "step"),
      childOf(halfKnown, foster, "foster"),
    ],
  };
}

/**
 * Our export of a third-party file, which is the shape a real import takes.
 *
 * `roundTripBytes` rather than a decoded string, because `TGC55C.ged` is ANSEL
 * and decoding it as UTF-8 succeeds while producing mojibake — the one way
 * this could pass over the wrong text. See `test/gedcom-round-trip.ts`.
 */
function exportOfFixture(name: string): string {
  return roundTripBytes(readFileSync(join(FIXTURES, name))).first;
}

/** Every file to hand Gramps, by the name it is written under. */
export function grampsCorpus(): Readonly<Record<string, string>> {
  return {
    "seed-family.ged": writeGedcom(seeded),
    "every-form.ged": writeGedcom(everyForm()),
    "torture-round-trip.ged": exportOfFixture("TGC55C.ged"),
    "dirty-round-trip.ged": exportOfFixture("dirty-third-party.ged"),
  };
}
