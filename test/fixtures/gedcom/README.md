# GEDCOM fixtures

Files the tests in `lib/` read off disk with `readFileSync`. `docs/gedcom.md`
has the table of what each one is for; this file records where the **one that
is not ours** came from, because a third-party file that nobody can trace is
worth less than a synthetic one that is honest about being synthetic.

## `TGC55C.ged` — third party, unmodified

The GEDCOM 5.5 Torture Test. It is here because every other fixture in this
directory was written by somebody who already knew what this pipeline does,
and a file written by somebody who did not is the only kind that can contain a
combination nobody here would have thought to invent (`YEO-92`).

|                 |                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Obtained from   | `https://www.geditcom.com/downlds/TestGED.zip`, linked from `https://www.geditcom.com/gedcom.html` |
| Obtained on     | 2026-08-26                                                                                         |
| Archive dated   | 18 FEB 2003 (the download page's own date; the file's `HEAD.DATE` is 1 JAN 1998)                   |
| Authors         | H. Eichmann (1997), extensively modified by J. A. Nairn using GEDitCOM 2.9.4 (1999–2001)           |
| Licence         | "Feel free to copy and use this GEDCOM file for any non-commercial purpose."                       |
| SHA-256         | `f631b100ed8f8ff00ca9d3c6af6015039fe9ec3d30d661a826691d5c562d00e0`                                 |
| Archive SHA-256 | `839d3ec2befd614236259bdc295457b805ed38a81833651af97790425d908cc8`                                 |

### It is unmodified, and the name is part of that

Byte for byte what came out of the archive, under the archive's own filename
rather than this directory's kebab-case convention. Both are deliberate: the
digest above is only checkable against the published archive if the bytes are
untouched, and the file names _itself_ on its `1 FILE TGC55C.ged` line, so
renaming it would make the fixture contradict its own header on the first
line a reader looks at.

That also means it keeps its original **carriage-return-only** line
terminators — legal in 5.5, and a form no other fixture here has. The
repository's `.gitattributes` marks `*.ged` as `-text` so that a checkout on a
machine with `core.autocrlf` set cannot quietly rewrite them; a fixture whose
line endings depend on who cloned it is not a fixture.

### The licence, stated plainly

The permission above is quoted from the archive's `README.txt`, and the same
sentence is inside the fixture itself, in the `HEAD.NOTE` — which is the
happiest case for a fixture's licence, because it travels with the bytes and
cannot be separated from them by a copy.

It is **not** the repository's MIT licence, and it is narrower: it permits
non-commercial use only. This file is therefore the one path in the tree that
MIT does not cover. It is test data, read only by `lib/gedcom-round-trip.test.ts`,
imported by nothing under `app/` or `lib/`, and not part of any build output —
so the narrower grant constrains the test suite and stops there. Anybody
building something commercial on this repository should delete it and the
`describe` block that reads it.

### Provenance of the people in it

Nobody in it is real. The individuals are named "Joseph Tag Torture", "Torture
GEDCOM Matriarch", "Charlie Accented ANSEL" and so on — invented to be
maximally awkward rather than to be anyone, which is exactly why a file like
this can be committed and a real family's cannot.

The one piece of genuine personal data is the two authors' **own** published
contact details, in the `SUBM` records and the header: an email address each,
and the business address and telephone numbers of Nairn's RSAC Software. They
put it there themselves, on a file they have published for over twenty years
so that people could do precisely this with it. None of it reaches this
application: `SUBM` is a record type the parser reports as an unknown tag and
the mapping has nowhere to put, so it is dropped on import and never written
back out.

## Everything else here

`family.ged`, `continuations-crlf.ged`, `accents-utf8.ged`, `accents-ansel.ged`
and `dirty-third-party.ged` were written for this repository. `docs/gedcom.md`
says what each is for, and says at length why `dirty-third-party.ged` is kept
rather than replaced now that there is a real file beside it.
