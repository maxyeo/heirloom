# GEDCOM

GEDCOM is the interchange format every genealogy program reads and writes. It
is how a family tree gets into this application and how it gets back out
again, and being able to get it back out again is the promise that makes it
reasonable to put decades of somebody's work in here in the first place.

This page covers the **parser** — E6-T1 (`YEO-46`), the read half — and the
**mapping** onto `individuals`, `unions` and `union_children`, which is E6-T2
(`YEO-47`). The import flow around them is E6-T3 to E6-T5.

## The pipeline

Five modules, each with one job, in the order the bytes move through them:

| Module                   | Takes         | Gives                                   |
| ------------------------ | ------------- | --------------------------------------- |
| `lib/ansel.ts`           | bytes         | text                                    |
| `lib/gedcom-encoding.ts` | bytes         | text, and which character set           |
| `lib/gedcom-lines.ts`    | text          | a tree of tagged nodes                  |
| `lib/gedcom.ts`          | bytes or text | individuals, families, a report         |
| `lib/gedcom-map.ts`      | that          | rows for the three tables, and a report |

`lib/gedcom-report.ts` holds the vocabulary the last three use to say what they
could not use.

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
npm package at all — see `lib/gedcom.purity.test.ts`, which walks both import
closures, the parser's and the mapper's, and asserts it.

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
it was not stored. Four cases, all in the table above. It stays a different
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
interval has no reader anywhere in this application.

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
policy E6-T2 would be inventing on its own, and E6-T4 owns the question it
belongs to: an all-or-nothing import may decide that any refusal fails the
whole file, in which case a per-field rescue here is cleverness that never
runs.

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
