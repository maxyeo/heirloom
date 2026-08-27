# Gramps

`YEO-51`'s last acceptance criterion named **Gramps**, because it is free and
strict — a permissive reader that shrugs at a malformed file tells you nothing,
and complaining is the property that made it worth picking. That criterion was
then met by proxy: Gramps needs PyGObject and GTK, `pip install gramps`
succeeds and dies on `import gi`, and two permissive third-party parsers were
run instead. The substitution was labelled rather than hidden, but a proxy is
not the thing, and `YEO-91` is the ticket that went and got the thing.

Debian packages Gramps with the GTK stack already assembled, so the whole
obstacle turns out to be four lines of `Dockerfile`. `npm run gramps:check`
builds that image, writes the corpus, imports every file, and prints what
Gramps said.

| File         | What it is                                                    |
| ------------ | ------------------------------------------------------------- |
| `Dockerfile` | Debian trixie plus `gramps`, which is the entire recipe       |
| `corpus.ts`  | The four exports handed to Gramps, built from this repository |
| `check.ts`   | The run: build, import, re-export, read back                  |
| This file    | What it said, on the day it was run                           |

## What was run, and when

|              |                                                            |
| ------------ | ---------------------------------------------------------- |
| Date         | 2026-08-26                                                 |
| Gramps       | 6.0.1 (Debian `6.0.1+dfsg-1`, from `debian:trixie-slim`)   |
| Python / GTK | 3.13.5 / GTK 3.24.49, pygobject 3.50.0                     |
| Command      | `gramps -C <tree> -i <file>.ged -e <file>.from-gramps.ged` |
| Host         | `docker` on macOS, `linux/arm64` container                 |

No display server is involved. Gramps' CLI initialises GTK, complains once
that it cannot find an icon theme, and imports the file anyway; `check.ts`
filters that line and two others (no PyICU, no generated locales) because they
are facts about the container rather than about any GEDCOM file.

## The verdict

**Every file imported with "No errors detected".** Both of the departures from
5.5.1 that `docs/gedcom.md` records as deliberate were accepted, and one of
them turned out to be a defect on the _return_ leg — see below.

The four files are built rather than committed, because each is a function of
code in this repository and a copy on disk would be a fifth thing to keep in
step:

| File                     | Why it is in the corpus                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `seed-family.ged`        | The remarriage chain — the graph the data model was designed for |
| `every-form.ged`         | Every sex, pedigree, qualifier and precision the export writes   |
| `torture-round-trip.ged` | Our export of `TGC55C.ged`, the 5.5 Torture Test                 |
| `dirty-round-trip.ged`   | Our export of the synthetic dirty fixture                        |

### The negative control is the load-bearing part

"No errors detected" four times is only evidence if the check can produce
anything else. So the run ends by handing Gramps
`test/fixtures/gedcom/dirty-third-party.ged` — not our export of it, the dirty
fixture itself — and Gramps reports **six errors**. That is what makes the
four clean lines above a result rather than a tautology.

## What Gramps thought of the two deliberate departures

**`CHAR UTF-8`**, where 5.5.1 lists only `ANSEL`, `UNICODE` and `ASCII`.
Accepted without comment — and Gramps 6.0.1 writes `1 CHAR UTF-8` in its own
5.5.1 export, which is a stronger endorsement than acceptance. The departure
stands, and `docs/gedcom.md` now says so on Gramps' authority rather than on
an argument about what modern readers probably do.

**`PEDI step`**, which is not one of 5.5.1's four pedigree values. Also
accepted — Gramps reads it as its own `stepchild` relation. This is where the
run earned its keep: Gramps writes that relation back out as **`PEDI
stepchild`**, a spelling `PEDIGREES` in `lib/gedcom-map.ts` did not read. A
family who moved a tree from here into Gramps and back again therefore arrived
home with every step-child recorded as biological. Nothing was silent about it
— the import reported the loss once per child — but a reported loss is still a
loss, and the file was making a statement this application could have read.

`stepchild` is now in the table, listed after `step` so that `step` remains
the spelling the export writes and no existing export changes by a byte. No
permissive parser could have found this: it needed a reader with an opinion of
its own about how to spell the value back.

## The transcript

Verbatim from `npm run gramps:check`, less npm's own banner and the one
`Building …` line the script prints before the image is built:

```
 gramps    : 6.0.1
 Python    : 3.13.5
 Gtk++     : 3.24.49
 pygobject : 3.50.0
=== seed-family.ged ===
Created empty Family Tree successfully
Importing: file /corpus/seed-family.ged, format ged.
GEDCOM import report: No errors detected
Exporting: file /out/seed-family.from-gramps.ged, format ged.
Cleaning up.
=== every-form.ged ===
Created empty Family Tree successfully
Importing: file /corpus/every-form.ged, format ged.
GEDCOM import report: No errors detected
Exporting: file /out/every-form.from-gramps.ged, format ged.
Cleaning up.
=== torture-round-trip.ged ===
Created empty Family Tree successfully
Importing: file /corpus/torture-round-trip.ged, format ged.
GEDCOM import report: No errors detected
Exporting: file /out/torture-round-trip.from-gramps.ged, format ged.
Cleaning up.
=== dirty-round-trip.ged ===
Created empty Family Tree successfully
Importing: file /corpus/dirty-round-trip.ged, format ged.
GEDCOM import report: No errors detected
Exporting: file /out/dirty-round-trip.from-gramps.ged, format ged.
Cleaning up.
=== dirty-third-party.ged (negative control) ===
Opened successfully!
Importing: file /fixtures/dirty-third-party.ged, format ged.
GEDCOM import report: 6 errors detected Line ignored
Could not import portrait.jpg                                       Line    35: 1 OBJE
Error: INDI 'I0099' (input as @I99@) not in input GEDCOM. Record with typifying attribute 'Unknown' created
Error: family 'F0001' (input as @F01@) child 'I0099' (input as 'I99') does not refer back to the family. Reference added.
Error: family 'F0002' (input as @F02@) child 'I0002' (input as 'I02') does not refer back to the family. Reference added.
Error: family 'F0003' (input as @F03@) child 'I0007' (input as 'I07') does not refer back to the family. Reference added.
The imported file was not self-contained.
To correct for that, 1 objects were created and
their typifying attribute was set to 'Unknown'.
Where possible these 'Unknown' objects are
referenced by note N0002.
Cleaning up.
=== read back into this application ===
--- seed-family.from-gramps.ged ---
Gramps wrote: 1 CHAR UTF-8 | 2 PEDI adopted | 2 PEDI birth
16 individuals, 4 unions, 12 child links
relations: adopted, biological
issues: none
--- every-form.from-gramps.ged ---
Gramps wrote: 1 CHAR UTF-8 | 2 PEDI adopted | 2 PEDI birth | 2 PEDI foster | 2 PEDI stepchild
8 individuals, 3 unions, 4 child links
relations: adopted, biological, foster, step
issues: none
--- torture-round-trip.from-gramps.ged ---
Gramps wrote: 1 CHAR UTF-8 | 2 PEDI adopted | 2 PEDI birth
15 individuals, 7 unions, 10 child links
relations: adopted, biological
issues: none
--- dirty-round-trip.from-gramps.ged ---
Gramps wrote: 1 CHAR UTF-8 | 2 PEDI adopted | 2 PEDI birth
6 individuals, 2 unions, 2 child links
relations: adopted, biological
issues: none
```

The last block is the out-and-back leg, and it is the half a bare import
cannot show: a reader can accept a file and still lose what is in it. Every
person, union and child link comes home, `every-form` brings `step` back with
it since the fix, and this application reports no issue on any of the four.

Its `Gramps wrote:` lines are quoted out of Gramps' own export rather than
summarised, because the two claims this page makes about the departures are
claims about bytes in a file — `1 CHAR UTF-8` written by Gramps unprompted,
and our `PEDI step` handed back as `2 PEDI stepchild`. Reporting only what
this application derived from those files would leave a reader who trusts
nothing but this transcript taking both on the author's word, which is the
shape of the problem this ticket exists to fix.

## When to run it again

When the exporter changes what it writes — a new tag, a new vocabulary member,
a change to the header. It is deliberately not part of `npm test`: CI's bare
job has no Docker, and a 230 MB apt install is not something to put in front of
every push. What is in the suite is the part that can be: the fixed point in
`lib/gedcom-round-trip.test.ts`, and `PEDI stepchild` in
`lib/gedcom-map.test.ts`.
