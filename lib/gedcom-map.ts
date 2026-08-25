import { type ChildRelation, validateChildLink } from "./child-input";
import type {
  GedcomEvent,
  GedcomFamily,
  GedcomFile,
  GedcomIndividual,
} from "./gedcom";
import type { GedcomIssue } from "./gedcom-report";
import {
  type DatePrecision,
  type DateQualifier,
  type IndividualFields,
  validateIndividual,
} from "./individual-input";
import {
  type UnionEndReason,
  type UnionFields,
  type UnionType,
  validateUnion,
} from "./union-input";

/**
 * Parsed GEDCOM in, `individuals` / `unions` / `union_children` out
 * (E6-T2, `YEO-47`).
 *
 * ## What this is
 *
 * The join between two vocabularies that were designed around the same idea.
 * `lib/gedcom.ts` stops at the last point that is still true of the *file*;
 * this module is the first point that is true of the *schema*. `INDI` becomes
 * an `individuals` row, `FAM` a `unions` row, `CHIL` a `union_children` row,
 * and because `docs/architecture.md` took GEDCOM's own insight — that the
 * union is the entity, not the person — most of that really is a rename.
 *
 * Where it is not a rename, the ticket asked for a finding rather than a
 * workaround. There are six, and they are written up in
 * `docs/architecture.md` under
 * [What GEDCOM has that this schema does not](architecture.md#what-gedcom-has-that-this-schema-does-not).
 * In short: a person must have a first name and GEDCOM's need not; a person
 * has one name here and many there; a union has no place column and `MARR`
 * has a `PLAC`; `PEDI` is written on the child's record while the edge it
 * describes is written on the family's; `union_end_reason` has a `death`
 * member that GEDCOM has no tag for at all; and `sequence` has no GEDCOM
 * equivalent whatsoever.
 *
 * ## No database, on purpose — and ids minted here
 *
 * Nothing in this module touches `@/db`, and `lib/gedcom.purity.test.ts`
 * asserts it, for the reason the parser's own docblock gives: E6-T3 (`YEO-48`)
 * shows a preview *before* anything is written, and that is only possible if
 * deciding what to write and writing it are separate operations. This is the
 * half that decides.
 *
 * Which forces one thing that looks odd at first: **the row ids are minted
 * here, not by Postgres.** `unions.partner_a_id` and `union_children` are
 * foreign keys, so the rows cannot be assembled until the ids exist, and
 * `validateUnion`/`validateChildLink` refuse anything that is not shaped like
 * one of this schema's primary keys (`lib/row-id.ts`) — which is exactly the
 * check that would have to be skipped to pass an xref through instead. The
 * alternative, inserting individuals first and reading their ids back, needs
 * a live transaction in the middle of the mapping and would drag the database
 * into the one module that is meant to stay out of it. `defaultRandom()` in
 * `db/schema.ts` is a default, not a constraint, so a supplied `uuid` is
 * ordinary. E6-T4 (`YEO-49`) can then be one bulk insert inside one
 * transaction, with nothing left to resolve.
 *
 * ## It writes through E3-T1's validation layer, not around it
 *
 * Every row goes through `validateIndividual`, `validateUnion` or
 * `validateChildLink` before it is emitted, and their verdicts are final. An
 * import is untrusted input in exactly the way a form post is — more so, since
 * nobody typed it — and a second, import-only set of rules is how the two
 * paths start disagreeing about what a valid row is.
 *
 * **A record the validator refuses is left out, and every link to it goes
 * with it.** That is a real cost: one typo'd death date removes a person, and
 * their children then have one recorded parent instead of two. The considered
 * alternative was to drop the offending *field* and re-validate — blank the
 * date, keep the person. It was rejected because it is a recovery policy this
 * ticket would be inventing on its own, and E6-T4 owns the question it really
 * belongs to: an all-or-nothing import may well decide that any refusal fails
 * the whole file, in which case a per-field rescue here would be cleverness
 * that never runs. Skipping is the honest, reversible answer, and every skip
 * says so on the report with the reason the validator gave.
 *
 * ## The report is the parser's, extended
 *
 * `issues` is the file's own list with this module's appended, and the file's
 * half is passed through **byte for byte**. That matters most for `narrowed`,
 * which is the vocabulary `YEO-88` built for a date that was read but not
 * everything beside it. Those four losses — an `INT` phrase, a modifier on a
 * range endpoint, an unreadable upper bound, and `EST` read as `about` — are
 * decisions with reasons, already worded for the person who has to act on
 * them. Re-describing them here would give one loss two spellings in one
 * report, and a reader no way to know it was one loss.
 */

/** An `individuals` row, ready to insert, and where it came from. */
export type MappedIndividual = {
  /** Minted here; see the docblock above. */
  id: string;
  /** The `INDI` record's identifier, for joining the rest of the file up. */
  xref: string | null;
  /** The line the `INDI` starts on, for the report. */
  line: number;
  /** Exactly what `validateIndividual` returned, and nothing added after. */
  values: IndividualFields;
};

/** A `unions` row, ready to insert, and where it came from. */
export type MappedUnion = {
  id: string;
  /** The `FAM` record's identifier. */
  xref: string | null;
  line: number;
  values: UnionFields;
};

/**
 * A `union_children` row, ready to insert.
 *
 * No `xref` or `line`: this row *is* its two foreign keys, and both of them
 * carry a mapped record that has the provenance already.
 */
export type MappedChild = {
  unionId: string;
  childId: string;
  relation: ChildRelation;
};

/** Everything a `.ged` file turned out to say, in this schema's terms. */
export type GedcomMapping = {
  individuals: MappedIndividual[];
  unions: MappedUnion[];
  unionChildren: MappedChild[];
  /**
   * The file's issues, unchanged, followed by this module's.
   *
   * Concatenated rather than merged by line, because "unchanged" has to
   * include the order the parser found them in — and a report that wants them
   * chronological can sort a list it was handed whole, where it could not
   * unpick a list that had already been interleaved.
   */
  issues: GedcomIssue[];
};

/**
 * What goes in `given_name` when the file gives nothing to put there.
 *
 * `individuals.given_name` is `not null` and `validateIndividual` insists on
 * it, because every surface in this application labels a person with it.
 * GEDCOM has no such rule: `1 NAME /Smith/` is an ordinary way to record a
 * woman known only by her married surname, and an `INDI` with no `NAME` at
 * all is how a program records a person who is only known to have existed.
 *
 * Skipping them was the obvious alternative and is much worse: those are
 * precisely the people who exist in the file *because* they are somebody's
 * parent, so dropping them deletes the edge that was the only reason to
 * record them. The placeholder is reported every time, so nothing about it is
 * silent, and "Unknown" is already this application's word for a person it
 * cannot name — `PersonPanel` and `UnionOrder` both render an absent partner
 * as "Unknown partner".
 */
const UNNAMED = "Unknown";

/**
 * `PEDI`, and the `child_relation` member each value means.
 *
 * 5.5.1 offers `birth`, `adopted`, `foster` and `sealing`. `step` is not in
 * the specification and is written by more than one program; it is a member
 * of our enum, so reading it costs nothing and refusing it would throw away a
 * fact the file went out of its way to record — the same reasoning `SEX_CODES`
 * gives for accepting `X`.
 *
 * `sealing` is deliberately absent: it is an LDS ordinance, not a kind of
 * parentage, and it is handled below with a sentence of its own rather than
 * quietly folded into `biological` by a table.
 *
 * Exported for E7-T1 (`YEO-51`), which inverts it to write `PEDI` back out.
 * The reversal is a lookup over this table rather than a table of its own, for
 * the reason `SEX_CODES` gives in `lib/gedcom.ts`: two tables describing one
 * correspondence drift the day somebody edits one of them.
 */
export const PEDIGREES: Readonly<Record<string, ChildRelation>> = {
  birth: "biological",
  adopted: "adopted",
  foster: "foster",
  step: "step",
};

/**
 * Map a parsed file onto this schema.
 *
 * Pure, total, and does not throw: everything that can go wrong comes back on
 * `issues`. A file that is entirely unreadable maps to three empty lists and a
 * report saying why, which is a result E6-T3 can render.
 */
export function mapGedcom(file: GedcomFile): GedcomMapping {
  const issues: GedcomIssue[] = [...file.issues];

  const individuals: MappedIndividual[] = [];
  const byXref = new Map<string, MappedIndividual>();
  const sourceByXref = new Map<string, GedcomIndividual>();
  const knownIndividuals = new Map<string, GedcomIndividual>();

  for (const individual of file.individuals) {
    // Unconditional, and the only one of the three that is: this map answers
    // "was this identifier in the file at all", which is what separates a
    // broken pointer from a pointer to somebody this import refused. A
    // refused record is still a record the file contained.
    //
    // A map rather than a set of xrefs since E6-T5 (`YEO-50`), and for one
    // reason: a skip has to name the record it left out, and the only place
    // a *refused* person's name still exists is the `INDI` the file gave.
    // `byXref` cannot answer — the whole point is that the person is not in
    // it — and `sourceByXref` is deliberately populated only for records that
    // validated. First writer wins, matching `byXref` above, so a duplicated
    // xref names the same record here as everywhere else.
    if (individual.xref !== null && !knownIndividuals.has(individual.xref)) {
      knownIndividuals.set(individual.xref, individual);
    }

    const values = mapIndividual(individual, issues);
    if (values === null) continue;

    const mapped: MappedIndividual = {
      id: crypto.randomUUID(),
      xref: individual.xref,
      line: individual.line,
      values,
    };
    individuals.push(mapped);

    // First *surviving* record wins on a duplicate identifier. The parser has
    // already reported the duplication as a `pointer` issue, and every
    // reference to it is ambiguous either way — picking the earliest one that
    // validated at least makes the choice the same one every time this file
    // is imported.
    //
    // Both maps are written here, together, and that is load-bearing rather
    // than tidy. They are keyed the same way and read as a pair — `byXref`
    // gives the row a pointer resolves to, `sourceByXref` gives the `INDI`
    // that row was built from, and `relationFor` reads `PEDI` off the second
    // for a child it found through the first. Populating `sourceByXref`
    // earlier, before validation, made them disagree in exactly one case: a
    // duplicated xref whose first record was refused and whose second was
    // not. The pointer then resolved to the surviving row while `PEDI` was
    // read off the discarded one, so an adopted child came out biological
    // with nothing on the report to explain it. One write site is what makes
    // that unrepresentable.
    if (individual.xref !== null && !byXref.has(individual.xref)) {
      byXref.set(individual.xref, mapped);
      sourceByXref.set(individual.xref, individual);
    }
  }

  const sequences = deriveSequences(file.families);

  const unions: MappedUnion[] = [];
  const unionChildren: MappedChild[] = [];
  const knownFamilies = new Set<string>();
  const childrenOf = new Map<string, Set<string>>();

  for (const family of file.families) {
    if (family.xref !== null) {
      knownFamilies.add(family.xref);
      // Added to rather than replaced. Two `FAM` records can share an xref —
      // the parser reports that, and does not resolve it — and this map backs
      // a *cross-check*, where the question is "does any record bearing this
      // identifier agree with the person's own `FAMC`". Overwriting would
      // answer for whichever duplicate happened to come last and invent a
      // disagreement with the other, which is a false alarm on a report whose
      // whole value is that it only speaks when something is wrong.
      const children = childrenOf.get(family.xref) ?? new Set<string>();
      for (const child of family.children) children.add(child);
      childrenOf.set(family.xref, children);
    }

    const values = mapFamily(
      family,
      byXref,
      knownIndividuals,
      sequences.get(family) ?? 0,
      issues,
    );
    if (values === null) continue;

    const union: MappedUnion = {
      id: crypto.randomUUID(),
      xref: family.xref,
      line: family.line,
      values,
    };
    unions.push(union);

    unionChildren.push(
      ...mapChildren(
        family,
        union,
        byXref,
        sourceByXref,
        knownIndividuals,
        issues,
      ),
    );
  }

  reportOneSidedLinks(file, knownFamilies, childrenOf, issues);

  return { individuals, unions, unionChildren, issues };
}

/**
 * One `INDI` as an `individuals` row, or `null` when it was refused.
 *
 * The date columns are the ticket's own acceptance criterion and they are the
 * least interesting part of this function, which is the point: `YEO-88`
 * widened every event to five columns whose shape is exactly `ParsedDate`, so
 * `ABT`, `BEF`, `AFT`, a bare year, `BET x AND y` and `FROM x TO y` all arrive
 * already in the schema's terms and this only has to spell the field names
 * out. A range with a month on one end and a year on the other needs no case
 * of its own because each bound carries its own precision column.
 */
function mapIndividual(
  individual: GedcomIndividual,
  issues: GedcomIssue[],
): IndividualFields | null {
  const [primary, ...alternates] = individual.names;

  if (primary === undefined || primary.given === null) {
    issues.push({
      kind: "value",
      line: individual.line,
      message: `This person's first name is not recorded in the file, so "${UNNAMED}" was used. Every person in this tree needs one.`,
    });
  }

  if (alternates.length > 0) {
    issues.push({
      kind: "value",
      line: individual.line,
      message: `This person has ${alternates.length + 1} names in the file and this tree records one, so "${primary?.full ?? ""}" was kept and ${alternates
        .map((name) => `"${name.full}"`)
        .join(", ")} left out.`,
    });
  }

  const birth = readEvent(individual.birth);
  const death = readEvent(individual.death);

  const checked = validateIndividual({
    givenName: primary?.given ?? UNNAMED,
    surname: primary?.surname ?? null,
    sex: individual.sex,
    birthDate: birth.date,
    birthDateQualifier: birth.qualifier,
    birthDatePrecision: birth.precision,
    birthDateUpper: birth.upper,
    birthDateUpperPrecision: birth.upperPrecision,
    birthPlace: birth.place,
    deathDate: death.date,
    deathDateQualifier: death.qualifier,
    deathDatePrecision: death.precision,
    deathDateUpper: death.upper,
    deathDateUpperPrecision: death.upperPrecision,
    deathPlace: death.place,
    // `NOTE` is outside the parser's subset, so there is never anything here.
    // Named explicitly rather than left off, so that the day `NOTE` joins the
    // subset the compiler has somewhere obvious to point.
    notes: null,
  });

  if (checked.ok) return checked.value;

  for (const issue of checked.issues) {
    issues.push({
      kind: "skipped",
      line: individual.line,
      record: {
        tag: "INDI",
        xref: individual.xref,
        label: primary?.full ?? null,
      },
      message: `This person could not be recorded, so they and every family link to them were left out. ${issue.message}`,
    });
  }

  return null;
}

/** One `FAM` as a `unions` row, or `null` when it was refused. */
function mapFamily(
  family: GedcomFamily,
  byXref: ReadonlyMap<string, MappedIndividual>,
  knownIndividuals: ReadonlyMap<string, GedcomIndividual>,
  sequence: number,
  issues: GedcomIssue[],
): UnionFields | null {
  const partnerA = resolvePartner(
    family,
    "HUSB",
    family.husband,
    byXref,
    knownIndividuals,
    issues,
  );
  const partnerB = resolvePartner(
    family,
    "WIFE",
    family.wife,
    byXref,
    knownIndividuals,
    issues,
  );

  const start = readEvent(family.marriage);
  const end = readEvent(family.divorce);

  reportLostPlace(family, "marriage", start.place, issues);
  reportLostPlace(family, "divorce", end.place, issues);

  const checked = validateUnion({
    partnerAId: partnerA?.id ?? null,
    partnerBId: partnerB?.id ?? null,
    type: unionType(family),
    startDate: start.date,
    startDateQualifier: start.qualifier,
    startDatePrecision: start.precision,
    startDateUpper: start.upper,
    startDateUpperPrecision: start.upperPrecision,
    endDate: end.date,
    endDateQualifier: end.qualifier,
    endDatePrecision: end.precision,
    endDateUpper: end.upper,
    endDateUpperPrecision: end.upperPrecision,
    endReason: endReason(family, partnerA, partnerB),
    sequence,
    notes: null,
  });

  if (checked.ok) return checked.value;

  for (const issue of checked.issues) {
    issues.push({
      kind: "skipped",
      line: family.line,
      record: { tag: "FAM", xref: family.xref, label: null },
      message: `This family could not be recorded, so it and its children's links to it were left out. ${issue.message}`,
    });
  }

  return null;
}

/**
 * `MARR`/`DIV` present means a marriage; their absence means nobody said.
 *
 * `unknown` rather than the column's own `marriage` default. A `FAM` is
 * GEDCOM's word for two people with children between them, and it is written
 * for unmarried couples as readily as for married ones — the tag that says
 * "married" is `MARR`, and inferring one from a bare `FAM` would put a
 * wedding in the tree that the file never claimed. A `DIV` with no `MARR` is
 * the one place the inference is safe, because nothing divorces that was not
 * married.
 */
function unionType(family: GedcomFamily): UnionType {
  return family.marriage !== null || family.divorce !== null
    ? "marriage"
    : "unknown";
}

/**
 * How the union ended, which GEDCOM never states and always implies.
 *
 * `union_end_reason` has five members and GEDCOM has one relevant tag. `DIV`
 * is `divorce` directly. `death` has to be inferred, because a marriage ends
 * when a partner dies and no file records that as an event of the *family* —
 * it is an event of the person, and it is already in the tree by the time
 * this runs.
 *
 * Divorce wins over death when a file says both: a couple who divorced and
 * later buried one of the two ended their marriage at the divorce.
 *
 * **The inferred `death` sets no end date**, which is the whole reason it is
 * safe to infer. The date is already recorded once, on the person who died,
 * and copying it onto the union would make two rows that have to be edited
 * together forever — correct the death date and the marriage would go on
 * claiming the old one. `union_end_reason` is not obliged to have a date
 * beside it; only the reverse is refused, and `validateUnion` is where.
 */
function endReason(
  family: GedcomFamily,
  partnerA: MappedIndividual | null,
  partnerB: MappedIndividual | null,
): UnionEndReason {
  if (family.divorce !== null) return "divorce";

  const bereaved = [partnerA, partnerB].some(
    (partner) => partner !== null && partner.values.deathDate !== null,
  );

  return bereaved ? "death" : "ongoing";
}

/**
 * `HUSB`/`WIFE` as a partner id, and `null` for every way there isn't one.
 *
 * Three different absences, told apart because they mean different things to
 * whoever reads the report: the file did not name a partner (ordinary, and
 * exactly what nullable partner columns are for — no issue); it named one
 * that is not in the file (a broken pointer); or it named one this import
 * refused (already reported at the person, and repeated here because the
 * consequence lands on a different record).
 */
function resolvePartner(
  family: GedcomFamily,
  tag: "HUSB" | "WIFE",
  xref: string | null,
  byXref: ReadonlyMap<string, MappedIndividual>,
  knownIndividuals: ReadonlyMap<string, GedcomIndividual>,
  issues: GedcomIssue[],
): MappedIndividual | null {
  if (xref === null) return null;

  const mapped = byXref.get(xref);
  if (mapped !== undefined) return mapped;

  const role = tag === "HUSB" ? "husband" : "wife";

  if (knownIndividuals.has(xref)) {
    issues.push({
      kind: "skipped",
      line: family.line,
      record: {
        tag: `FAM.${tag}`,
        xref,
        label: nameInFile(knownIndividuals, xref),
      },
      message: `FAM.${tag} names ${xref}, who could not be recorded, so this family has no ${role}.`,
    });
    return null;
  }

  issues.push({
    kind: "pointer",
    line: family.line,
    message: `FAM.${tag} names ${xref}, which is not a record in this file, so this family has no ${role}.`,
  });

  return null;
}

/**
 * `CHIL` as `union_children` rows.
 *
 * The edge comes from the family and the relation comes from the child, which
 * is finding four: GEDCOM writes `CHIL` under `FAM` and `PEDI` under the
 * child's own `FAMC`, so one column needs two records to fill it. `FAM.CHIL`
 * stays authoritative for *which* links exist, as `docs/gedcom.md` has said
 * since the parser: the same edges are written on both sides, and one side
 * has to be the one that counts.
 */
function mapChildren(
  family: GedcomFamily,
  union: MappedUnion,
  byXref: ReadonlyMap<string, MappedIndividual>,
  sourceByXref: ReadonlyMap<string, GedcomIndividual>,
  knownIndividuals: ReadonlyMap<string, GedcomIndividual>,
  issues: GedcomIssue[],
): MappedChild[] {
  const rows: MappedChild[] = [];
  const seen = new Set<string>();

  for (const xref of family.children) {
    const child = byXref.get(xref);

    if (child === undefined) {
      issues.push(
        knownIndividuals.has(xref)
          ? {
              kind: "skipped",
              line: family.line,
              record: {
                tag: "FAM.CHIL",
                xref,
                label: nameInFile(knownIndividuals, xref),
              },
              message: `FAM.CHIL names ${xref}, who could not be recorded, so they are not a child of this family.`,
            }
          : {
              kind: "pointer",
              line: family.line,
              message: `FAM.CHIL names ${xref}, which is not a record in this file, so it was left out.`,
            },
      );
      continue;
    }

    // `union_children` is keyed on the pair, so a repeated `CHIL` is a row
    // that cannot be written twice. Reported rather than deduplicated in
    // silence: a file that names one child twice may have meant two.
    if (seen.has(child.id)) {
      issues.push({
        kind: "skipped",
        line: family.line,
        record: {
          tag: "FAM.CHIL",
          xref,
          label: nameInFile(knownIndividuals, xref),
        },
        message: `FAM.CHIL names ${xref} more than once, and a child belongs to a family once, so the repeat was left out.`,
      });
      continue;
    }

    // A person cannot be their own parent's partner. `lib/save-child.ts`
    // refuses this on the typed path as `child-is-partner`; there is no
    // shared validator for it, because `validateChildLink` never sees the
    // union's partners, so the check is repeated here rather than skipped.
    if (
      child.id === union.values.partnerAId ||
      child.id === union.values.partnerBId
    ) {
      issues.push({
        kind: "skipped",
        line: family.line,
        record: {
          tag: "FAM.CHIL",
          xref,
          label: nameInFile(knownIndividuals, xref),
        },
        message: `FAM.CHIL names ${xref}, who is also a partner in this family, so the link was left out.`,
      });
      continue;
    }

    const checked = validateChildLink({
      unionId: union.id,
      childId: child.id,
      relation: relationFor(sourceByXref.get(xref), family, issues),
    });

    if (!checked.ok) {
      for (const issue of checked.issues) {
        issues.push({
          kind: "skipped",
          line: family.line,
          record: {
            tag: "FAM.CHIL",
            xref,
            label: nameInFile(knownIndividuals, xref),
          },
          message: `${xref} could not be recorded as a child of this family. ${issue.message}`,
        });
      }
      continue;
    }

    seen.add(child.id);
    rows.push({
      unionId: union.id,
      childId: child.id,
      relation: checked.value.relation,
    });
  }

  return rows;
}

/**
 * What the file calls a record, for a skip that has to name it.
 *
 * The file's own `NAME` line rather than anything this application would
 * render, and that is the point: a skip is read beside the `.ged` it came
 * from, so the string that helps is the string somebody can search their file
 * for. It is also the only one available — a refused person never became a
 * row, so there are no `given_name` and `surname` columns to format.
 *
 * `null` when the file names the record nothing, which is ordinary: an `INDI`
 * with no `NAME` is how a program records somebody known only to have
 * existed, and the xref beside it still says which record it was.
 */
function nameInFile(
  knownIndividuals: ReadonlyMap<string, GedcomIndividual>,
  xref: string,
): string | null {
  return knownIndividuals.get(xref)?.names[0]?.full ?? null;
}

/**
 * `PEDI` on the child's matching `FAMC` as a `child_relation`.
 *
 * Takes the *parsed* child rather than the mapped one, because `PEDI` is a
 * fact about the file and `MappedIndividual` is deliberately only the row.
 * Widening the row to carry its own source record would put the parser's
 * types into this module's output, where E6-T3 and E6-T4 would then have two
 * representations of one person to keep straight.
 */
function relationFor(
  source: GedcomIndividual | undefined,
  family: GedcomFamily,
  issues: GedcomIssue[],
): ChildRelation {
  const link = source?.familiesAsChild.find(
    (candidate) => candidate.family === family.xref,
  );

  // No `FAMC` back at the child, or one with no `PEDI`. Neither is a loss:
  // `biological` is what the column means when a file says nothing, and the
  // edge itself came from `FAM.CHIL`, which is the authoritative side.
  if (link === undefined || link.pedigree === null) return "biological";

  const relation = PEDIGREES[link.pedigree];
  if (relation !== undefined) return relation;

  issues.push({
    kind: "value",
    line: link.line,
    message:
      link.pedigree === "sealing"
        ? `"sealing" is a religious ordinance rather than a kind of parentage, so this child was recorded as biological.`
        : `"${link.pedigree}" is not a pedigree this import understands, so this child was recorded as biological. Expected birth, adopted, foster or step.`,
  });

  return "biological";
}

/**
 * Report a `FAMS`/`FAMC` that the family side does not agree with.
 *
 * The parser carries both halves of every edge — `FAMS`/`FAMC` on the person
 * and `HUSB`/`WIFE`/`CHIL` on the family — and says in its own docblock that
 * the redundancy is only worth keeping if somebody eventually cross-checks
 * it: "a file whose `FAMS` and `HUSB` disagree is a file whose tree will
 * import wrong". This is that somebody.
 *
 * The family side wins, because it is where the edges are read from, so a
 * disagreement is a link that will not be in the imported tree. Nothing is
 * reported for a file whose two halves agree, which is every well-formed
 * file, so this is silent until it has something to say.
 */
function reportOneSidedLinks(
  file: GedcomFile,
  knownFamilies: ReadonlySet<string>,
  childrenOf: ReadonlyMap<string, ReadonlySet<string>>,
  issues: GedcomIssue[],
): void {
  // Accumulated, not replaced, for the reason `childrenOf` is — see the
  // comment beside it in `mapGedcom`.
  const partnersOf = new Map<string, Set<string>>();
  for (const family of file.families) {
    if (family.xref === null) continue;

    const partners = partnersOf.get(family.xref) ?? new Set<string>();
    for (const xref of [family.husband, family.wife]) {
      if (xref !== null) partners.add(xref);
    }
    partnersOf.set(family.xref, partners);
  }

  for (const individual of file.individuals) {
    if (individual.xref === null) continue;

    for (const xref of individual.familiesAsSpouse) {
      if (!knownFamilies.has(xref)) {
        issues.push({
          kind: "pointer",
          line: individual.line,
          message: `INDI.FAMS names ${xref}, which is not a record in this file.`,
        });
        continue;
      }

      if (!partnersOf.get(xref)?.has(individual.xref)) {
        issues.push({
          kind: "pointer",
          line: individual.line,
          message: `INDI.FAMS says this person is a partner in ${xref}, but that family names somebody else, so no partnership was recorded.`,
        });
      }
    }

    for (const link of individual.familiesAsChild) {
      if (!knownFamilies.has(link.family)) {
        issues.push({
          kind: "pointer",
          line: link.line,
          message: `INDI.FAMC names ${link.family}, which is not a record in this file.`,
        });
        continue;
      }

      if (!childrenOf.get(link.family)?.has(individual.xref)) {
        issues.push({
          kind: "pointer",
          line: link.line,
          message: `INDI.FAMC says this person is a child of ${link.family}, but that family does not list them, so no link was recorded.`,
        });
      }
    }
  }
}

/**
 * `unions.sequence`, which GEDCOM has no equivalent of at all.
 *
 * The column orders a person's unions on their own panel, and a file says
 * nothing about it — so the ticket asks for date order, falling back to file
 * order. Both halves are needed: `MARR` is frequently absent, and a union
 * with no start date has nothing to sort by.
 *
 * The rule is therefore: **dated families in date order, undated families
 * after them in file order.** Putting the undated ones last is not an
 * arbitrary tie-break, it is what this application already does — `addSpouse`
 * appends a new union at `nextSequence`, one past the highest its partners
 * have, whether or not it is dated. An import that interleaved them would be
 * ordering imported unions by a rule the application's own writes do not use.
 *
 * The number is per *person*, not per file, which is what `nextSequence`
 * means by "one past the highest": a union takes one more than the highest
 * either of its partners has reached, so a remarriage counts 0, 1, 2 down
 * each partner's own list rather than counting the whole file. A union both
 * of whose partners are new starts at 0.
 *
 * That per-person counting is also what keeps the number away from
 * `MAX_UNION_SEQUENCE`: the ceiling is 1000 and a person's sequence cannot
 * exceed the number of families they appear in, so only somebody recorded
 * with more than a thousand partnerships in one file would reach it. Such a
 * union is refused by `validateUnion` and reported — which is a strange
 * sentence to read on an import report, and a strange enough file that a
 * guard here would be inventing a case to handle.
 *
 * A family this mapping later refuses still consumes its number, leaving a
 * gap. Gaps are harmless — `ownUnions` sorts by the column and never reads the
 * values as an index — and closing them would mean deciding a family's
 * sequence after knowing whether it validated, which is a second pass to
 * remove holes nobody can see.
 */
function deriveSequences(
  families: readonly GedcomFamily[],
): Map<GedcomFamily, number> {
  const ordered = families
    .map((family, index) => ({
      family,
      index,
      start: family.marriage?.date?.date ?? null,
    }))
    .sort((a, b) => {
      if (a.start === b.start) return a.index - b.index;
      if (a.start === null) return 1;
      if (b.start === null) return -1;
      // ISO `YYYY-MM-DD`, so string order is date order — and the anchor
      // convention means a year sorts as its 1 January, which is the earliest
      // day it could be.
      return a.start < b.start ? -1 : 1;
    });

  const nextFor = new Map<string, number>();
  const sequences = new Map<GedcomFamily, number>();

  for (const { family } of ordered) {
    const partners = [family.husband, family.wife].filter(
      (xref): xref is string => xref !== null,
    );

    const sequence = Math.max(
      0,
      ...partners.map((xref) => nextFor.get(xref) ?? 0),
    );

    for (const xref of partners) nextFor.set(xref, sequence + 1);
    sequences.set(family, sequence);
  }

  return sequences;
}

/**
 * An event's five date columns and its place, with the absences filled in.
 *
 * The defaults are the schema's own (`exact`, `day`), not a guess: they are
 * what a `not null` qualifier and precision column hold beside a null date,
 * and `validateIndividual` normalises to the same values, so a person with no
 * birth date maps to the row a person with no birth date already has.
 */
function readEvent(event: GedcomEvent | null): {
  date: string | null;
  qualifier: DateQualifier;
  precision: DatePrecision;
  upper: string | null;
  upperPrecision: DatePrecision;
  place: string | null;
} {
  const date = event?.date ?? null;

  return {
    date: date?.date ?? null,
    qualifier: date?.qualifier ?? "exact",
    precision: date?.precision ?? "day",
    upper: date?.upper ?? null,
    upperPrecision: date?.upperPrecision ?? "day",
    place: event?.place ?? null,
  };
}

/**
 * Say so when a wedding's `PLAC` had nowhere to go.
 *
 * Finding three: `individuals` has `birth_place` and `death_place`, and
 * `unions` has no place column at all, so `MARR.PLAC` — which is in the
 * parser's subset and one of the most common lines in a real file — is read
 * and then dropped. Reported rather than folded into `notes`, because
 * `docs/architecture.md` spent the date-precision section arguing that facts
 * do not belong in `notes` "where nothing can query or format it", and a
 * marriage place is a fact of exactly that kind. The fix is a column, not a
 * string; it is written up as a finding and it is not this ticket.
 */
function reportLostPlace(
  family: GedcomFamily,
  label: "marriage" | "divorce",
  place: string | null,
  issues: GedcomIssue[],
): void {
  if (place === null) return;

  issues.push({
    kind: "value",
    line: family.line,
    message: `This family records where the ${label} happened ("${place}"), and a union in this tree has nowhere to keep a place, so it was left out.`,
  });
}
