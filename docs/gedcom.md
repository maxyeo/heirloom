# GEDCOM

GEDCOM is the interchange format every genealogy program reads and writes. It
is how a family tree gets into this application and how it gets back out
again, and being able to get it back out again is the promise that makes it
reasonable to put decades of somebody's work in here in the first place.

This page covers the **parser** — E6-T1 (`YEO-46`), the read half — the
**mapping** onto `individuals`, `unions` and `union_children`, which is E6-T2
(`YEO-47`), the **preview** somebody reads before an import happens, which is
E6-T3 (`YEO-48`), and the **export** back out, which is E7-T1 (`YEO-51`).
Writing the rows is E6-T4 and reporting on them afterwards is E6-T5.

## The pipeline

Six modules on the way in, each with one job, in the order the bytes move
through them:

| Module                   | Takes         | Gives                                   |
| ------------------------ | ------------- | --------------------------------------- |
| `lib/ansel.ts`           | bytes         | text                                    |
| `lib/gedcom-encoding.ts` | bytes         | text, and which character set           |
| `lib/gedcom-lines.ts`    | text          | a tree of tagged nodes                  |
| `lib/gedcom.ts`          | bytes or text | individuals, families, a report         |
| `lib/gedcom-map.ts`      | that          | rows for the three tables, and a report |
| `lib/gedcom-import.ts`   | those rows    | three tables written, or nothing at all |

And two on the way back out:

| Module                 | Takes                     | Gives       |
| ---------------------- | ------------------------- | ----------- |
| `lib/export-tree.ts`   | the database              | rows        |
| `lib/gedcom-export.ts` | rows for the three tables | GEDCOM text |

`lib/gedcom-report.ts` holds the vocabulary the reading modules use to say what
they could not use. The export has no equivalent and needs none: it is writing
a format it chose, not reading one somebody else wrote.

The line between the last two is where the vocabulary changes hands.
`lib/gedcom.ts` stops at the last point that is still true of the **file** —
`PEDI` is the word `birth`, a `FAM` is a `FAM`. `lib/gedcom-map.ts` is the
first point that is true of the **schema** — `birth` becomes `biological`, a
`FAM` becomes a `unions` row with a `sequence` no file ever mentioned.

The split is not decoration. Each boundary is a place where the thing being
tested changes shape, so each module's test can be written in the terms that
module actually works in: byte sequences for ANSEL, four-line strings for the
grammar, whole files for the parser.

## The one thing that must stay true

**Nothing here reaches the database.** No `@/db`, no React, no `next/*`, no
npm package at all — see `lib/gedcom.purity.test.ts`, which walks all four
import closures — the parser's, the mapper's, the preview's and, since E7-T1
(`YEO-51`), the exporter's — and asserts it.

The mapper's closure is the parser's plus the three E3-T1 validation modules
(`lib/individual-input.ts`, `lib/union-input.ts`, `lib/child-input.ts`) and
`lib/row-id.ts` behind them. That is the rule holding rather than bending:
those modules are pure by construction, and the mapping writing _through_ them
is the acceptance criterion, so the test asserts their presence as well as the
absence of everything else.

That is an acceptance criterion rather than a preference, because three later
tickets rest on it:

- **E6-T3** shows a preview _before_ anything is written, which is only
  possible if reading a file and writing rows are separate operations.
- **E6-T4** rolls a failed import back, which needs the same separation.
- **E7-T2** round-trips export through import through export and compares the
  results. A parser that needed a database could only be tested against one,
  which would make the round trip a test of the schema instead of the format.

## Dates go through the shared grammar

`ABT`, `BEF`, `AFT`, `EST`, `1890`, `MAR 1890` and `12 MAR 1890` are all read
by `parseDateInput` in `lib/parse-date.ts` — the same function standing behind
the date field a person types into, written for E4-T2 (`YEO-39`) with this
ticket named in its docblock as the second caller.

Sharing it is not just less code. It means an imported `ABT 1890` and a typed
`about 1890` become the same three column values, so nothing downstream can
tell which route a date arrived by. A second, GEDCOM-only date grammar would
break that the first time the two disagreed, and the disagreement would be
invisible.

## Ranges are stored whole

GEDCOM's range and period forms are two dates, and since `YEO-88` every event
in this schema has two date columns to put them in.

| The file says                    | Stored as                                     | Reported                    |
| -------------------------------- | --------------------------------------------- | --------------------------- |
| `BET 1890 AND 1900`              | `1890` to `1900`, both year precision         | no — nothing is lost        |
| `FROM 1912 TO 1918`              | `1912` to `1918`, both year precision         | no — nothing is lost        |
| `BET MAR 1890 AND 1900`          | `March 1890` to `1900`, month then year       | no — nothing is lost        |
| `FROM 1912`                      | `after 1912`, year precision, no upper bound  | no — nothing is lost        |
| `TO 1918`                        | `before 1918`, year precision, no upper bound | no — nothing is lost        |
| `BET ABT 1890 AND 1900`          | `1890` to `1900` — the `ABT` goes             | yes — the endpoint modifier |
| `FROM ABT 1912`                  | `after 1912` — the `ABT` goes                 | yes — the endpoint modifier |
| `BET 1890 AND (some Tuesday)`    | `after 1890` — the upper bound is unreadable  | yes — the upper bound       |
| `INT 1890 (from baptism record)` | `about 1890`, year precision                  | yes — the phrase            |
| `EST 1918`                       | `about 1918`, year precision                  | yes — that it was estimated |

The two headline rows are the ticket: **the common range forms now raise no
issue at all**, because nothing about them is dropped. Each endpoint keeps its
own precision, which is why `BET MAR 1890 AND 1900` does not have to choose
between throwing the March away and inventing one for 1900.

Each endpoint goes through `parseDateInput` like any other date, so this
module still learns a _splitter_ and not a second date grammar — the property
the section above defends. What changed is what the splitter does with the
halves: it stores both instead of dropping one.

A range's qualifier is `exact`, and there is no `between` member on
`date_qualifier`. The reasoning is in
[Ranges, and the columns that hold them](architecture.md#ranges-and-the-columns-that-hold-them),
and the short version sits beside the enum in `db/schema.ts`.

**`narrowed` survived this ticket with a much smaller remit.** It now means
what its name says and nothing more: the date was read, and something beside
it was not stored. Four kinds, in five rows of the table above — the endpoint
modifier appears twice, once for each shape a bound comes in. It stays a different
kind from `date` for the reason it always did — a `date` issue means the field
is **blank** and somebody has to go and fix the file, a `narrowed` issue means
the field is **populated and slightly poorer**, and one report cannot answer
"how many dates could this import not read" if the two share a word.

A range whose _lower_ bound cannot be read is still refused outright — a
`date` issue, field blank, text kept. A range whose _upper_ bound cannot be
read is not: the lower bound is a date the file genuinely gave, so it is
stored as `after` that bound and the upper one is reported. There is no
arbitrary choice being made in either case, which is the difference.

`BET 1900 AND 1890` — a range written backwards — is stored exactly as
written, with no issue from this module. Reading a file and validating against
the schema are different jobs; `validateIndividual` is where an inverted range
is refused, and E6-T2 is what runs it.

`EST` is the fourth and the odd one out: it is not a range, its reading is
older than `YEO-88` — `lib/parse-date.ts` has always mapped `est` onto `about`,
because `date_qualifier` has four members and "estimated" is not one of them —
and E6-T2 changed nothing about what is stored. What it changed is that the
loss now has a sentence. `EST 1918` was the only lossy date form in the whole
pipeline that went through without one, which made "how many dates did this
import narrow" a question the report could not answer honestly. An `EST` on a
range endpoint is reported once, by the endpoint rule, not twice.

Two things a range still does not carry. **`FROM x TO y` and `BET x AND y`
become the same row** — a period ("it lasted from") and a range ("it happened
somewhere in") are a distinction this schema has no column for, and for a
birth or a death the period reading is a data-entry habit rather than a claim.
And an endpoint's own modifier goes, because a fuzzy edge on a bound of an
interval has no reader anywhere in this application. That holds for a bound
standing on its own as much as for one end of a pair: `FROM ABT 1912` becomes
`after 1912` and says so. Review of E6-T2 found the one-sided forms dropping
the modifier in silence, which had made this a rule that held for
`BET ABT 1890 AND 1900` and quietly failed for `FROM ABT 1890` — one rule,
both shapes.

That leaves one thing worth knowing before E7-T2 (`YEO-52`) is written: **a
third-party file's `FROM 1912 TO 1918` comes back out as `BET 1912 AND
1918`.** The round trip that closes is export -> import -> export, which is
what the test is for — our own output only ever writes `BET ... AND`, so it is
stable from the first pass.

## The mapping onto the three tables

`lib/gedcom-map.ts` (E6-T2, `YEO-47`) takes a parsed file and gives back rows
for `individuals`, `unions` and `union_children`, plus the report. It writes
nothing: E6-T3 has to be able to say what an import _would_ do before it does
any of it, so deciding what to write and writing it are separate operations,
and this is the half that decides. E6-T4 is the half that writes.

Most of it really is a rename, which is the point `docs/architecture.md` has
been making since the data model was chosen:

| GEDCOM      | This schema               |
| ----------- | ------------------------- |
| `INDI`      | an `individuals` row      |
| `FAM`       | a `unions` row            |
| `HUSB`      | `unions.partner_a_id`     |
| `WIFE`      | `unions.partner_b_id`     |
| `CHIL`      | a `union_children` row    |
| `INDI.PEDI` | `union_children.relation` |

A `FAM` naming only one parent maps with the other column null and no issue
raised — nullable partner columns are exactly what
[the data model](architecture.md#data-model) has for a child whose father
nobody can name.

**The rows carry ids minted here, not by Postgres.** `partner_a_id` and
`union_children` are foreign keys, so the rows cannot be assembled until the
ids exist, and `validateUnion` refuses anything not shaped like one of this
schema's primary keys — which is precisely the check that would have to be
skipped to pass an xref through instead. `defaultRandom()` in `db/schema.ts`
is a default, not a constraint. E6-T4 is then one bulk insert with nothing
left to resolve.

### The four things a file does not say

- **How a union ended.** `DIV` is `divorce` directly. `death` has to be
  inferred, because a marriage ends when a partner dies and no file records
  that as an event of the _family_ — it is an event of the person, already in
  the tree by the time the mapping runs. Divorce wins when a file says both.
  The inferred `death` deliberately sets **no end date**: the date is recorded
  once, on the person who died, and copying it onto the union would make two
  rows that have to be corrected together forever.
- **Whether they were married.** `MARR` or `DIV` present means `marriage`;
  neither means `unknown`. A bare `FAM` is GEDCOM's word for two people with
  children between them and is written for unmarried couples as readily as for
  married ones, so inferring a wedding from it would put one in the tree that
  the file never claimed.
- **`unions.sequence`**, which GEDCOM has no equivalent of at all. Dated
  families in date order, undated ones after them in file order. Putting the
  undated last is not an arbitrary tie-break: `addSpouse` already appends a new
  union one past the highest its partners have, dated or not, so this is the
  rule the application's own writes use. The number counts down each _person's_
  own list, so a remarriage is 0, 1, 2 for that person rather than a position
  in the file.
- **Which side owns a child link.** `CHIL` is on the family and `PEDI` is on
  the child's own `FAMC`, so one column needs two records to fill it. `FAM.CHIL`
  stays authoritative for _which_ links exist; `PEDI` only says what kind.
  `birth`, `adopted`, `foster` and the non-standard-but-common `step` are read;
  `sealing` is a religious ordinance rather than a kind of parentage and is
  recorded as `biological` with a sentence saying so.

### A record the validator refuses is left out

Every row goes through `validateIndividual`, `validateUnion` or
`validateChildLink` before it is emitted, and their verdicts are final. An
import is untrusted input in the way a form post is — more so, since nobody
typed it — and a second, import-only set of rules is how the two paths start
disagreeing about what a valid row is.

So a person whose death date is before their birth date is **not imported**,
and every family link to them goes with them: the family keeps its other
partner and loses this one to a null. That is a real cost, and it is reported
every time with the sentence the validator gave.

The considered alternative was to drop the offending _field_ and re-validate —
blank the date, keep the person. It was rejected because it is a recovery
policy E6-T2 would be inventing on its own, and the question it belongs to
was E6-T4's: whether an all-or-nothing import should decide that any refusal
fails the whole file.

**E6-T4 (`YEO-49`) answered no**, and the reasoning is
[below](#the-write-half): all-or-nothing is a property of the write, not of
the reading. So the skipping described here is the behaviour, and a per-field
rescue remains a thing nobody has asked for.

`BET 1900 AND 1890` is where the two halves meet. The parser stores it exactly
as written and raises nothing, because reading a file and judging it are
different jobs; `validateIndividual` is what refuses an inverted range, and
this is what runs it.

### The report is the parser's, extended

`issues` is the file's own list with the mapping's appended, and the file's
half is passed through **byte for byte** — the same objects, in the same
order. That matters most for `narrowed`: those four losses are decisions with
reasons, already worded for the person who has to act on them, and
re-describing them here would give one loss two spellings in one report with
no way to tell it was one loss.

The mapping's own additions are `value` (a fact with nowhere to go, a record
refused) and `pointer` (a `HUSB`, `CHIL`, `FAMS` or `FAMC` naming a record
that is not in the file, or one whose two halves disagree). The cross-check
between `FAMS`/`FAMC` and `HUSB`/`WIFE`/`CHIL` is the one the parser's own
docblock promised: carrying both halves is only worth it if somebody
eventually compares them. It says nothing about a file whose halves agree,
which is every well-formed file.

## The write half

`lib/gedcom-import.ts` (E6-T4, `YEO-49`) takes a mapping and writes it into
`individuals`, `unions` and `union_children` — all of it, or none of it.

### All or nothing is a property of the _write_

The reason the ticket exists: a half-imported tree is worse than no import,
because it looks like data, so nobody re-runs it, and the gaps surface one at
a time over months. One transaction is the whole answer. Every row lands or
none does, and the tree is never left in a state nobody chose.

That is deliberately **not** the same rule as "any refusal fails the file".
A record `validateIndividual` refused is a reported skip, and the import
proceeds. The distinction is which half of the pipeline the guarantee is
about:

- the transaction is there so a tree is never half-**written**;
- a tree that is fully written, and honestly described as missing one person
  whose death date preceded their birth, is not half-anything. It is the whole
  of what the file could be read as, plus a report saying what the rest was.

Failing an entire file on one unreadable date would make dirty files
unimportable, and this epic exists precisely because real GEDCOM files are
dirty. A rule that refuses every real file is not a safety property. The count
of what was skipped is on the preview the reader confirms (E6-T3) and on the
report afterwards (E6-T5), so a skip is consented to rather than discovered.

### Nothing is decided here

By the time a `GedcomMapping` arrives, the three validators have run and what
they refused is already gone. The ids were minted in memory and every foreign
key resolved, which is what makes the write one bulk insert with nothing to
read back mid-transaction.

The insert order — individuals, then unions, then child links — is still
required, and pre-resolved ids do not remove the requirement. Postgres checks
a foreign key when the row is inserted unless the constraint is `DEFERRABLE`,
and none in `db/schema.ts` are. What the pre-resolution buys is the absence of
a read in the middle of the write, not freedom from ordering.

### Batching, and the two ceilings

`lib/import-batches.ts` is the arithmetic, kept separate so `npm test` can
check it in CI's bare environment — the acceptance criterion is a claim about
a number of round trips, and a claim about a number should not need Postgres
to verify. A file with several hundred people is **one statement per table**,
three round trips for the import.

Two limits govern, and they are different kinds of thing:

| Constant                 | Value  | Kind                                           |
| ------------------------ | ------ | ---------------------------------------------- |
| `MAX_BIND_PARAMETERS`    | 65,533 | correctness — the driver refuses beyond it     |
| `MAX_ROWS_PER_STATEMENT` | 1,000  | prudence — statement duration and pool holding |

65,533 rather than the protocol's usual 65,535 because that is where
postgres.js actually refuses: `connection.js` throws at `>= 65534`, so 65,533
is the largest count that reaches Postgres.

The row cap is the one that binds in practice — the widest table here is 19
columns, so the parameter ceiling is 3,449 rows away. It exists because
`statement_timeout` is a per-statement budget rather than a per-import one: one
enormous insert is a single timer that either fits or fails the whole file,
where fifty smaller ones are each comfortably inside it. It also bounds how
long an import holds a pooled connection, since Supabase's pooler runs in
transaction mode and pins a backend for the length of the transaction.

The parameter ceiling is therefore a guard rather than a working limit, kept
because this schema has already been widened once for expressiveness
(`YEO-88`) and the next widening should not be able to overflow the wire
protocol in silence.

### The function timeout

The criterion asks for the import to finish inside Vercel's function timeout
_or_ to run in chunks that are individually safe to retry. Those are not both
available: chunks that commit independently are exactly the half-imported tree
this ticket exists to prevent. So the import completes in one invocation, and
whichever route comes to call it must set `maxDuration` — that is a
requirement on the route rather than something already wired, since
`maxDuration` is a route-segment export and E6-T4 deliberately adds no route.

What makes overrunning it safe is the transaction rather than the number. A
function killed mid-import never reaches `commit`, so the tree is untouched
and the reader can simply upload the file again. The timeout is a failure to
import, never a partial import.

### A hazard for whoever edits this next

**postgres.js commits a transaction callback that returns normally.** It
issues `rollback` only when the callback _throws_. Any refusal added inside
the transaction later must `throw`, not `return` — returning a refusal after a
write reports it and commits it anyway.

That is not hypothetical; it is the bug `lib/reorder-unions.ts` shipped and
then fixed, and `lib/reorder-unions.db.test.ts` pins the semantics against a
real database. `refuse` in `lib/set-parents.ts` is the idiom for doing it
correctly. Both are deliberately absent from `lib/gedcom-import.ts` today,
because it has nothing to refuse: every decision was made before the
transaction opened, so anything that goes wrong inside it is a genuine fault
and is left to propagate.

## Writing it back out

`lib/gedcom-export.ts` (E7-T1, `YEO-51`) is the mapping run backwards: rows for
the three tables in, a GEDCOM 5.5.1 file out. `lib/export-tree.ts` is the thin
half that reads the rows, and it is the only part of the export that knows
`@/db` exists — the serialiser itself is under the same purity rule as the
parser and the mapper, and `lib/gedcom.purity.test.ts` walks its closure too.

Being able to get a tree back out again is the promise that makes it reasonable
to put decades of somebody's work in here in the first place, so this is a
feature of the data model rather than a convenience on top of it.

### It reverses the mapping rather than restating it

That is an acceptance criterion, and it is the kind that decays quietly: a
second table saying `adopted` -> `adopted` typechecks forever and stops
agreeing with the first the day somebody adds a member to one of them.

So the two vocabulary tables are **imported and inverted**. `SEX_CODES` lives
in `lib/gedcom.ts` and `PEDIGREES` in `lib/gedcom-map.ts`; the exporter reads
each one backwards, and the test drives every member of `Sex` and of
`ChildRelation` out through the file and back in through the mapper — so a new
enum member without a spelling is a test failure rather than a line quietly
missing from somebody's export.

Two things genuinely cannot be inverted, and they are the two the import side
reads _many_ spellings of: `QUALIFIER_PREFIXES` maps sixteen words onto four
qualifiers, and `MONTHS` maps twenty-two onto twelve. An inverse would have to
pick one spelling per member, which is a choice about output rather than a
fact recoverable from the input table. The exporter makes that choice
explicitly — `ABT`, `BEF`, `AFT`, and `JAN` to `DEC` — and the test holds it to
the same standard by round-tripping every string it can emit.

### Deterministic, because E7-T2 compares bytes

E7-T2 (`YEO-52`) round-trips export -> import -> export and requires the two
texts to be identical. Three things follow.

- **No clock, no randomness, no environment.** The header's `DATE` is optional
  in 5.5.1 and is not written. A timestamp would make every export of an
  unchanged tree a different file, which defeats the round trip and also
  defeats the much more ordinary case of diffing two backups.
- **Ordering is derived from what survives the trip.** The row ids do not: an
  export writes `@I1@` and a re-import mints fresh UUIDs. So individuals sort
  on surname, given name and their two dates, unions on where each partner
  landed in that order and on their own dates, and the caller's order breaks a
  tie. `unions.sequence` is deliberately not a sort key — GEDCOM has no
  equivalent, so it is re-derived on the way in and would put the second export
  in a different order from the first.
- **Strings compare by code unit, not by locale.** `localeCompare` depends on
  whatever ICU data the process was built with.

The xrefs are then positional — `I1`, `F1` — which is what makes them stable
without being derived from an id that is not.

### It writes what it is given, and does not validate

The round trip closes for every tree this application can produce — which is
every tree that went through `validateIndividual`, `validateUnion` and
`validateChildLink`. Where a row can be written _around_ those by hand, the
export still writes a file that says what a reader will read:

- A **place is collapsed** exactly as the parser collapses it. `readText` only
  trims on the way into the column, so `Whitby,  Yorkshire` with two spaces is
  a storable value — and written verbatim it would come back with one space and
  the second export would disagree with the first.
- A **name is trimmed** and deliberately _not_ collapsed, because the parser
  trims a name and does not collapse one. `John  Henry` survives the trip
  exactly as stored.
- A **`FAM` with no partner is not written.** `validateUnion` refuses one — a
  union needs at least one partner — so the record would say nothing about
  anybody. It is dropped before the xrefs are handed out, so it cannot shift
  the numbering of the families that are intact.
- A **`CHIL` naming one of the family's own partners is not written.**
  `1 WIFE @I2@` beside `1 CHIL @I2@` is a contradiction no reader can resolve,
  and the mapping refuses it by name on the way back in.

What the export does **not** do is repair a row whose _values_ the schema
refuses. A birth recorded as `BET 1900 AND 1890`, or a person in a union with
themselves, is written faithfully and then declined by the validators on the
way back in, with a sentence on the import report saying so. Silently reversing
the bounds would be the export inventing a recovery policy the import side
deliberately does not have, and hiding a broken row rather than surfacing it.

### What a first export narrows

Three states the schema can hold and GEDCOM cannot. All three lose the same
thing the import side would have lost anyway, all three are **stable from the
second pass on**, and none of them is silent in the sense that matters: the
loss is a property of the format, written down here, rather than of a
particular file.

| The schema says                       | The file says     | Read back as               |
| ------------------------------------- | ----------------- | -------------------------- |
| `type` `partnership`, with a date     | `MARR` and a date | `marriage`                 |
| `type` `partnership`, undated         | nothing           | `unknown`                  |
| `end_reason` `separation` / `unknown` | nothing           | `ongoing`, or `death`      |
| `sequence`                            | nothing           | re-derived from file order |

`end_reason` `divorce` is `DIV` directly, and `death` is deliberately not
written: `lib/gedcom-map.ts` infers it back from the partners' own death dates,
which is where the date already lives and the only place it should ever be
corrected. An `end_date` beside a reason GEDCOM has no tag for goes with the
reason — the alternative is writing `DIV` for a couple who did not divorce,
which is a claim the file would then be making on this application's behalf.

`notes` on either table are not written either, and that one is not a
narrowing so much as a scope line. The parser does not read `NOTE`, so a note
written here would be dropped on the way back in and absent from the second
export — the round trip would fail on data the exporter had invented a use
for. E7-T4 (`YEO-54`) is the ticket that puts entries and notes in a backup, as
JSON beside the GEDCOM rather than inside it, because the genealogy standard
has nowhere to put a wiki.

Everything else is written back, including both bounds of a range and the
`PEDI` on every child link.

### Two small departures from 5.5.1, both deliberate

`CHAR UTF-8`, where the specification lists only `ANSEL`, `UNICODE` and
`ASCII`. Every reader written this century takes UTF-8 — it is what 5.5.5 went
on to require — and the alternative is writing ANSEL, which cannot represent
most of the world's names and is the character set `lib/ansel.ts` exists to
rescue people _from_.

And `PEDI step`, which is not one of 5.5.1's four pedigree values. It is a
member of `child_relation` and it is written by more than one program, so the
import side already reads it; refusing to write it would throw away a fact on
the way out that the same pipeline was happy to accept on the way in.

The header is otherwise complete, including the `SUBM` pointer and the
submitter record it names — both mandatory in 5.5.1, and both checked by the
strict validators. The submitter is the application rather than a person:
nothing in this schema records who exported a file, and inventing a name for
them would be worse than naming the program that wrote it.

## Nothing is dropped in silence

Real GEDCOM files are dirty, and the subset this application supports is far
smaller than what a thirty-year-old desktop program emits. A parser that
quietly keeps what it recognises looks like it worked — the tree comes out
smaller than the one that went in, and nobody can say which branch is missing.

So every result carries two lists, and they mean different things:

- **`unknownTags`** — valid GEDCOM this application has nowhere to put:
  `SOUR`, `NOTE`, `OBJE`, vendor extensions. Not an error, a scope statement.
  Aggregated by dotted path (`INDI.SOUR`) with a count and a first line
  number, because the per-occurrence list is unbounded exactly where it is
  least useful. A tag is reported once, at the point comprehension stopped —
  the children of an unread tag are part of the same unread structure.
- **`issues`** — something that was meant to be understood and could not be: a
  date nobody can read, a `HUSB` that is not a pointer, two records sharing an
  identifier, a line that is not a GEDCOM line.

Merging them would bury the second in the first: a file with 4,000 `SOUR` tags
and one unreadable birth date would report 4,001 problems.

`FAMS` and `FAMC` are the one deliberate exception to "unrecognised means
reported". They are redundant — the same edges are written on the `FAM` side —
so reporting them would put "we ignored 240 things" into a report where
nothing was lost. They are parsed onto the individual instead.

## Previewing an import

> Uploading the wrong file must not be a database restore.

E6-T3 (`YEO-48`) puts a stop between choosing a file and importing it.
`/import` uploads the `.ged` to `POST /api/import`, which parses it, maps it,
and answers with counts, a dozen names, and every warning above — and writes
nothing. A second request, carrying the digest of the file that was previewed,
is what imports it.

| Module                        | What it owns                                         |
| ----------------------------- | ---------------------------------------------------- |
| `lib/import-preview.ts`       | The cap, the counts, the sample, the warning groups  |
| `lib/import-endpoint.ts`      | The URL and the two field names, shared by both ends |
| `app/api/import/route.ts`     | The session guard, the multipart form, the branch    |
| `components/GedcomImport.tsx` | The three stages of the screen                       |

### Nothing on this path can write

`lib/import-preview.ts` is under the same import-closure rule as the parser
and the mapper, and `lib/gedcom.purity.test.ts` asserts it: no `@/db`, no npm
package, nothing outside the parser's own closure plus `lib/person-format.ts`.

That is deliberately stronger than "the preview does not write". _Cancelling_
reaches none of this code either — cancel is the second request never being
sent, not a request that gets ignored — but a preview that **could** write
would make the guarantee worth nothing the first time somebody added a
convenience to it.

### Why the file is uploaded twice

A serverless function keeps nothing between requests, so the confirming
request carries the file again along with the SHA-256 of the bytes the preview
described. The endpoint recomputes it and refuses a mismatch with `409`. That
is what makes "explicit confirm step" a statement about _this file_ rather
than about a second button press.

The alternative — stash the parsed mapping server-side under a token — needs
somewhere to stash it, which is either the database the preview must not touch
or the blob store, and it leaves every cancelled import as something to clean
up later.

### There is no format sniff

GEDCOM has no magic bytes, and it does not need one. `parseGedcom` is total: a
file that is not GEDCOM comes back with no records and an issue per line, so
the preview says _"0 people, 0 unions, 214 lines that are not GEDCOM"_, which
tells whoever picked it far more than a rejection would. The only things
refused before parsing are a file too large to buffer and an empty one.

### What the screen shows, and in what order

Counts first, then the names, then warnings worst-first — the character set
leads, because a file read as the wrong one has every accented name in it
wrong and nothing else matters until that is settled, and `narrowed` comes
last, because it is the one group that means _nothing to fix_.

Unknown tags are kept out of that list entirely, under a heading of their own,
for the reason [Nothing is dropped in silence](#nothing-is-dropped-in-silence)
gives.

One warning is derived rather than passed through. _People with no name in the
file_ is counted off the `INDI` records themselves, because the mapper reports
it as `value` alongside unrelated findings and the only way to pull it back
out of `issues` would be to match on the wording of a sentence somebody should
be free to reword. The `value` group then skips one issue per line the derived
group claims, so one loss does not get two spellings on one screen.

## Character encoding

Old files are frequently ANSEL, and the people most likely to have one are the
people whose trees are most worth importing. Decoding ANSEL as UTF-8 does not
fail; it produces mojibake through every accented name in the file.

**In ANSEL the diacritic comes _before_ the letter it modifies** — `0xE2 0x65`
is é — which is the reverse of Unicode. That reordering, plus an NFC pass so
`e` + U+0301 becomes the single code point people actually type, is what
`lib/ansel.ts` is for.

The character set is chosen in this order, and every override is reported:

1. A byte order mark, which is a statement made in the encoding itself.
2. The file's own `HEAD.CHAR` line, read out of the raw bytes as ASCII.
3. The bytes. UTF-8 is self-checking, so a sequence that is not valid UTF-8 is
   _proof_ the file is not UTF-8, whatever it claims. A file declaring UTF-8
   that fails this is read as ANSEL instead.

`ANSI` is not accepted as a synonym for anything. It meant Windows-1252, and
mapping it to UTF-8 would mangle exactly the characters somebody chose it for.

## Fixtures

`test/fixtures/gedcom/`, loaded with `readFileSync` from the tests in `lib/`.
This is the first place in the repository where a test reads a file off disk,
and it is justified by the thing under test being a _file format_ — a `.ged`
with a header, a trailer and records pointing at each other says something
that an inline string cannot.

Malformed input stays inline, in `lib/gedcom.test.ts`. Four broken lines next
to the assertion about them read better than a file you have to open.

| Fixture                  | What it is for                                     |
| ------------------------ | -------------------------------------------------- |
| `family.ged`             | Two unions, four dates, every qualifier, one range |
| `continuations-crlf.ged` | `\r\n`, `CONC`, `GIVN`/`SURN`, unknown tags        |
| `accents-utf8.ged`       | Accented names in UTF-8                            |
| `accents-ansel.ged`      | The same content, byte for byte, in ANSEL          |

The last two are a matched pair, and that is what makes the binary one
reviewable: the test asserts the two parse to **identical** individuals, so
whatever `accents-ansel.ged` contains, it has to mean what its readable twin
means. To regenerate it, encode the UTF-8 twin by decomposing each character
(NFD) and writing each combining mark _before_ its base letter, using the
table in `lib/ansel.ts`.
