# GEDCOM

GEDCOM is the interchange format every genealogy program reads and writes. It
is how a family tree gets into this application and how it gets back out
again, and being able to get it back out again is the promise that makes it
reasonable to put decades of somebody's work in here in the first place.

This page covers the **parser** — E6-T1 (`YEO-46`), the read half. The mapping
onto `individuals`, `unions` and `union_children` is E6-T2 (`YEO-47`) and the
import flow around it is E6-T3 to E6-T5.

## The pipeline

Four modules, each with one job, in the order the bytes move through them:

| Module                   | Takes         | Gives                           |
| ------------------------ | ------------- | ------------------------------- |
| `lib/ansel.ts`           | bytes         | text                            |
| `lib/gedcom-encoding.ts` | bytes         | text, and which character set   |
| `lib/gedcom-lines.ts`    | text          | a tree of tagged nodes          |
| `lib/gedcom.ts`          | bytes or text | individuals, families, a report |

`lib/gedcom-report.ts` holds the vocabulary the last two use to say what they
could not use.

The split is not decoration. Each boundary is a place where the thing being
tested changes shape, so each module's test can be written in the terms that
module actually works in: byte sequences for ANSEL, four-line strings for the
grammar, whole files for the parser.

## The one thing that must stay true

**Nothing here imports anything.** No `@/db`, no React, no `next/*`, no npm
package — see `lib/gedcom.purity.test.ts`, which walks the whole import
closure and asserts it.

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

## Ranges collapse onto `after`

GEDCOM's range and period forms are two dates, and every event in this schema
has one date column. `YEO-88` decided what happens to the second one: it is
not stored.

| The file says                    | Stored as                     | Reported                   |
| -------------------------------- | ----------------------------- | -------------------------- |
| `BET 1890 AND 1900`              | `after 1890`, year precision  | yes — the upper bound goes |
| `FROM 1912 TO 1918`              | `after 1912`, year precision  | yes — the upper bound goes |
| `FROM 1912`                      | `after 1912`, year precision  | no — nothing is lost       |
| `TO 1918`                        | `before 1918`, year precision | no — nothing is lost       |
| `INT 1890 (from baptism record)` | `about 1890`, year precision  | yes — the phrase goes      |

The precision is the lower bound's own. `BET MAR 1890 AND JUN 1890` is `after
March 1890` at month precision; `FROM 12 MAR 1912 TO 4 JUL 1918` is `after 12
March 1912` at day precision. Each endpoint goes through `parseDateInput` like
any other date, so this module learns a _splitter_ and not a second date
grammar — which is the property the section above defends.

The lower bound rather than a midpoint, because `after 1890` is a statement
the file makes and `about 1895` is one it does not. The whole argument is in
[Date precision](architecture.md#date-precision), and the short version sits
beside the enum in `db/schema.ts`.

Every collapse raises a **`narrowed`** issue naming the text that was read and
the value that was written, so the loss lands on the import report at the line
it happened on. `narrowed` is a different kind from `date` on purpose: a
`date` issue means the field is **blank** and somebody has to go and fix the
file, a `narrowed` issue means the field is **populated with something true
but weaker** and there is nothing to fix. One report cannot answer "how many
dates could this import not read" if the two are the same word.

A range whose _lower_ bound cannot be read is still refused outright — a
`date` issue, field blank, text kept. Reading the upper bound instead would be
picking an endpoint at random, which is the thing this whole decision is
avoiding. A bare date phrase — `(before the war)`, with no `INT` in front of
it — has no date in it to store and is refused for the same reason.

One consequence worth knowing before E7-T2 (`YEO-52`) is written: **a
third-party file containing a range does not round-trip byte for byte.** `BET
1890 AND 1900` comes back out as `AFT 1890`. The round trip that does close is
export -> import -> export, which is the property the test is actually for — our
own output is stable, and a foreign file's ranges are narrowed exactly once,
on the way in, with the report saying so.

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

| Fixture                  | What it is for                              |
| ------------------------ | ------------------------------------------- |
| `family.ged`             | Two unions, four dates, every qualifier     |
| `continuations-crlf.ged` | `\r\n`, `CONC`, `GIVN`/`SURN`, unknown tags |
| `accents-utf8.ged`       | Accented names in UTF-8                     |
| `accents-ansel.ged`      | The same content, byte for byte, in ANSEL   |

The last two are a matched pair, and that is what makes the binary one
reviewable: the test asserts the two parse to **identical** individuals, so
whatever `accents-ansel.ged` contains, it has to mean what its readable twin
means. To regenerate it, encode the UTF-8 twin by decomposing each character
(NFD) and writing each combining mark _before_ its base letter, using the
table in `lib/ansel.ts`.
