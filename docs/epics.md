# Epics

Work breakdown derived from `product.md`. Each epic states the outcome, the
tickets that get there, and what is explicitly not in it.

Ticket IDs (`E1-T1`) are local handles for sequencing. Each one is a Linear
issue in the **Heirloom** project (team `YEO`), noted alongside it below —
11 epic parents and 64 sub-issues, with `blockedBy` relations matching the
sequencing at the foot of this document.

https://linear.app/yeo-wiki/project/heirloom-f27db3b83d76

Ordering rule: the two things that make the site usable on a Sunday afternoon
are **writing an entry** (E1) and **adding a person without SQL** (E3).
Everything else is downstream of those.

---

## E1 — Wiki entries · `YEO-5`

**Outcome.** The author can create an entry, write in it, save it, see what it
looked like last week, and put it back.

**Why now.** The schema (`pages`, `revisions`) already exists and nothing reads
or writes it. Until this ships, the product is a read-only diagram.

**Depends on.** Nothing. Ships first.

| ID                | Ticket                           | Notes                                                                                                                                                                   |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1-T1<br>`YEO-15` | Page read route — `/wiki/[slug]` | Server component, `requireSession()`, renders `bodyHtml`. 404 for unknown slug. Sanitise on render as well as on write.                                                 |
| E1-T2<br>`YEO-16` | TipTap editor component          | Bold, italic, heading, list, link, image button (image disabled until E5). Nothing else in the toolbar — see the No-Markdown principle.                                 |
| E1-T3<br>`YEO-17` | Save action + revision write     | One server action: write `revisions` row, then update `pages`. Same transaction, so history can never be missing a step.                                                |
| E1-T4<br>`YEO-18` | HTML sanitisation module         | TipTap output is trusted-ish but the column is `text` and the renderer is `dangerouslySetInnerHTML`. Allowlist tags/attrs in one module, applied on write **and** read. |
| E1-T5<br>`YEO-19` | Revision history list            | `/wiki/[slug]/history` — timestamp, author email, in reverse order.                                                                                                     |
| E1-T6<br>`YEO-20` | Diff view between revisions      | Rendered HTML diff, not a source diff. The author does not read HTML.                                                                                                   |
| E1-T7<br>`YEO-21` | One-click restore                | Restoring writes a _new_ revision rather than deleting any. Append-only means restore is a copy.                                                                        |
| E1-T8<br>`YEO-22` | Create-page flow                 | Title in, slug auto-derived, collision handling. No slug field in the UI.                                                                                               |
| E1-T9<br>`YEO-23` | Page index at `/wiki`            | Alphabetical list of all entries. The fallback navigation until search (E8) exists.                                                                                     |

**Not in this epic.** Image upload (E5), search (E8), linking entries to people
(E2).

---

## E2 — Person ↔ page linking · `YEO-6`

**Outcome.** Clicking a node in the tree lands on that person's entry, and an
entry knows which person it is about.

**Why.** `individuals.page_id` already exists and is always null. This is the
seam that turns two features into one product.

**Depends on.** E1.

| ID                | Ticket                                       | Notes                                                                                                                    |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E2-T1<br>`YEO-24` | Person detail panel on node click            | Slide-over on the tree canvas: names, dates, places, notes, links to spouses/children/parents. Read-only in this ticket. |
| E2-T2<br>`YEO-25` | "Open entry" / "Create entry" from the panel | If `page_id` is set, link to it. If not, offer to create one pre-titled with the person's name and linked back on save.  |
| E2-T3<br>`YEO-26` | Backlink from entry to tree                  | An entry linked to a person shows a header card with lifespan and a "view in tree" link that deep-links the node.        |
| E2-T4<br>`YEO-27` | Deep link `/tree?person=<id>`                | Tree opens centred on that person and with the panel open. Makes every person link shareable.                            |
| E2-T5<br>`YEO-28` | Cross-entry linking in the editor            | The link button offers existing entries by title, not just raw URLs. This is what makes it wiki-shaped.                  |

**Not in this epic.** Automatic entry generation from person records.

---

## E3 — Tree editing · `YEO-7`

**Outcome.** The author can build the family out from the seed data using forms
only. No SQL, no dragging, no layout decisions.

**Why.** This is the feature that ends the dependency on `db/seed.ts`. Every
form here maps to exactly one of the three tables.

**Depends on.** Nothing technically; sequence after E1 only because entries are
the thing the author wants first.

| ID                 | Ticket                                           | Notes                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-T1<br>`YEO-29`  | Server actions for individuals — create / update | Validated, `requireSession()`, typed. The shared validation layer lands here.                                                                                                                                                                |
| E3-T2<br>`YEO-30`  | Add-person form                                  | Given name required, everything else optional. Unknown-parent case must be reachable without inventing placeholders.                                                                                                                         |
| E3-T3<br>`YEO-31`  | Edit-person form                                 | Same form, prefilled. Reached from the detail panel (E2-T1).                                                                                                                                                                                 |
| E3-T4<br>`YEO-32`  | Add-spouse flow                                  | Creates a `unions` row. Partner picker searches existing people or creates a new one inline. Type and end-reason are fields, not defaults to fix later.                                                                                      |
| E3-T5<br>`YEO-33`  | Add-child flow                                   | Creates a `union_children` row against a chosen union. Relation (biological/adopted/step/foster) is a field on the link.                                                                                                                     |
| E3-T6<br>`YEO-34`  | Set-parents flow                                 | Attach an existing person to an existing union — the "I added them standalone and now want to connect them" case.                                                                                                                            |
| E3-T7<br>`YEO-35`  | Union sequence editor                            | Reorder a person's unions when dates are unknown. The `sequence` column exists precisely for this; without UI it is unreachable.                                                                                                             |
| E3-T8<br>`YEO-36`  | Delete / detach with confirmation                | Deleting a person cascades to their union links. Confirmation must say what else disappears.                                                                                                                                                 |
| E3-T9<br>`YEO-37`  | Empty-state onboarding                           | A fresh install with zero people needs "add the first person", not a blank canvas.                                                                                                                                                           |
| E3-T10<br>`YEO-82` | Merge duplicate unions                           | E3-T6 can create a family inline without noticing the couple already had one. Detect it and offer the existing family; merge the two that already exist. A prompt, never a refusal — a couple who remarried each other must stay recordable. |

**Not in this epic.** Merging duplicate people, bulk edit.

---

## E4 — Date precision · `YEO-8`

**Outcome.** "about 1890" and "before 1920" are recordable as data rather than
as prose in `notes`.

**Why.** Listed as a known limitation in `architecture.md`, and it is the one
schema gap that gets _more_ expensive the longer it waits — every date typed
into the escape hatch before the fix is a date someone re-enters after it.

**Depends on.** E3 (forms are where qualifiers get entered).

| ID                | Ticket                            | Notes                                                                                                                                |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| E4-T1<br>`YEO-38` | Add qualifier columns + migration | `about` / `before` / `after` / `exact` alongside the existing `date` columns.                                                        |
| E4-T2<br>`YEO-39` | Date input component              | One field that parses "abt 1890", "1890", "before 1920". Never make a non-technical author choose a qualifier from a dropdown first. |
| E4-T3<br>`YEO-40` | Date formatting everywhere        | Node labels, detail panel, entry header cards. One formatter, one module.                                                            |

**Not in this epic.** Date ranges ("between 1890 and 1895"), calendar systems.

---

## E5 — Images · `YEO-9`

**Outcome.** Photographs in entries.

**Why.** A family wiki without photographs is a text file. Held behind the
editor work because the storage seam matters more than the feature.

**Depends on.** E1.

| ID                | Ticket                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5-T1<br>`YEO-41` | Storage module with one interface | `put` / `get` / `delete`. Vercel Blob behind it. Swapping hosts must be a one-file change — this is the portability claim in `architecture.md`, and it is only true if it is enforced from the first commit.                                                                                                                                                                                                                                                                                                                  |
| —<br>`YEO-86`     | Private store, expiring URLs      | The posture E5-T1 left open, decided: the store is private and read URLs expire fifteen minutes after they are minted, so images sit inside the `ALLOWED_EMAILS` boundary. One file, no call sites — see [Images](architecture.md#images).                                                                                                                                                                                                                                                                                    |
| E5-T2<br>`YEO-42` | Upload endpoint                   | `POST /api/images`, auth-gated, 4 MB cap, allowlist read from the bytes rather than the client's content type. Generated keys, validated before the store sees them. Location metadata stripped, orientation kept. Returns a **key** and a site-relative path — never a storage URL, which expires. `GET /api/images/…` resolves one back.                                                                                                                                                                                    |
| E5-T3<br>`YEO-43` | Image button in the editor        | Upload from disk, inserted at the cursor. No URL field — a file picker, a drop target and a paste handler, all reaching `POST /api/images`. Progress on the way up, and a canvas resize for anything over the 4 MB cap. `img[src]` joins the sanitiser's allowlist, restricted to this application's own image route.                                                                                                                                                                                                         |
| E5-T4<br>`YEO-44` | Person portrait                   | Two keys on `individuals` — the photograph and a thumbnail — shown on the tree node and in the detail panel, with a placeholder where there is none. The thumbnail is downscaled in the browser at pick time and uploaded through the same endpoint, because a few hundred nodes load at once and there is no image processor on the server. Node dimensions reserve the portrait's box for everybody, so the layout is identical whether or not a photograph exists. The wiki-entry infobox is **not** in scope — see below. |
| E5-T5<br>`YEO-45` | Orphaned-image cleanup            | Images referenced by no revision. Careful: append-only history means an old revision still refers to it, so "unreferenced" is stricter than it looks.                                                                                                                                                                                                                                                                                                                                                                         |

**Not in this epic.** Galleries, albums, face tagging, captions as a first-class
type. Also not in E5-T4: the portrait on the wiki-entry infobox
(`components/PersonInfobox.tsx`). The value is available to it for free once
the column exists, and a lead image is what an infobox is for — but the
infobox is E11's file and `lib/entry-person.ts`'s narrow `select` would have
to widen, so it is a follow-on rather than a silent extra.

---

## E6 — GEDCOM import · `YEO-10`

**Outcome.** An existing family file loads without retyping.

**Why.** `product.md` calls this out as the thing that decides whether the
project survives contact with real data. It is scheduled before export because
the failure mode it prevents (hand-typing hundreds of people) is fatal, and the
one export prevents is merely annoying.

**Depends on.** E3 (import writes through the same validation), E4 (GEDCOM
carries `ABT`/`BEF`/`AFT` qualifiers natively — importing before E4 throws that
information away silently).

| ID                | Ticket                          | Notes                                                                                                                                                                                 |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E6-T1<br>`YEO-46` | GEDCOM parser                   | 5.5.1 subset: `INDI`, `FAM`, `HUSB`, `WIFE`, `CHIL`, `BIRT`, `DEAT`, `MARR`, `DIV`. Parser is pure and unit-tested against fixture files — no database.                               |
| E6-T2<br>`YEO-47` | Map GEDCOM to the schema        | `FAM` → `unions`, `CHIL` → `union_children`. The model was designed against GEDCOM's insight, so this should be near-mechanical; where it isn't, that's a finding worth writing down. |
| E6-T3<br>`YEO-48` | Import preview                  | Counts and a sample before anything is written. Uploading the wrong file must not be a database restore.                                                                              |
| E6-T4<br>`YEO-49` | Transactional import + rollback | All-or-nothing. A half-imported tree is worse than no import.                                                                                                                         |
| E6-T5<br>`YEO-50` | Import report                   | What was skipped and why. Real GEDCOM files are dirty; silence is the wrong answer.                                                                                                   |

**Not in this epic.** Merging an import into an existing populated tree,
duplicate detection.

---

## E7 — GEDCOM export · `YEO-11`

**Outcome.** The family can take their data and leave.

**Why.** Stated as a real goal, not a nice-to-have. It is also the cheapest
insurance the project has: it makes every later decision reversible.

**Depends on.** E6 (share the mapping layer).

| ID                | Ticket                           | Notes                                                                                                               |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| E7-T1<br>`YEO-51` | Export the graph as GEDCOM 5.5.1 | Individuals, unions, children, dates with qualifiers.                                                               |
| E7-T2<br>`YEO-52` | Round-trip test                  | Export → import → export produces identical output. This is the ticket that proves the claim; the rest is plumbing. |
| E7-T3<br>`YEO-53` | Download from a settings page    | Plus a note on what is _not_ in the file (entry bodies, images) so nobody mistakes it for a full backup.            |
| E7-T4<br>`YEO-54` | Full backup export               | Entries and revisions as JSON alongside the GEDCOM. The genealogy standard has nowhere to put a wiki.               |

**Not in this epic.** Scheduled/automatic backups.

---

## E8 — Search and recency · `YEO-12`

**Outcome.** A reason to come back, and a way to find things once there are more
than fifty entries.

**Depends on.** E1.

| ID                | Ticket                                 | Notes                                                                                                                                           |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| E8-T1<br>`YEO-55` | Postgres full-text search over entries | `tsvector` column plus a GIN index. No search service — the corpus is a few hundred documents.                                                  |
| E8-T2<br>`YEO-56` | People search                          | Name, with the ability to jump straight to the tree node.                                                                                       |
| E8-T3<br>`YEO-57` | Combined search UI                     | One box, results grouped by entries and people.                                                                                                 |
| E8-T4<br>`YEO-58` | Recently changed feed                  | Home page. Draws from `pages.updated_at`, which is already indexed.                                                                             |
| E8-T5<br>`YEO-59` | "On this day"                          | Birthdays and anniversaries from the individuals and unions tables. The one feature here that is purely about giving someone a reason to visit. |

**Not in this epic.** Search within revision history.

---

## E9 — Operations · `YEO-13`

**Outcome.** The site is awake when someone visits it, and someone notices when
it isn't.

**Why.** `architecture.md` flags free-tier pausing as a known limitation. A
family wiki visited monthly gets found asleep, and "the site is broken" is how a
project like this loses its author.

**Depends on.** Nothing. E9-T1 is worth doing early and cheaply.

| ID                | Ticket                     | Notes                                                                                                                    |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E9-T1<br>`YEO-60` | Supabase keep-alive cron   | GitHub Actions, not Vercel Cron — it is a Supabase concern, not an application one.                                      |
| E9-T2<br>`YEO-61` | Production deploy runbook  | Env vars, Google OAuth setup, allowlist config, first migration. Written for someone who is not the person who built it. |
| E9-T3<br>`YEO-62` | Database backup schedule   | Pairs with E7-T4. Export is a user feature; this is the operator one.                                                    |
| E9-T4<br>`YEO-63` | Error reporting            | Somewhere errors go that isn't a browser console the author will never open.                                             |
| E9-T5<br>`YEO-64` | CI: typecheck, lint, build | The three scripts already in `package.json`, run on every push.                                                          |

---

## E10 — Quality bar · `YEO-14`

**Outcome.** Confidence that the boundary holds and the hard layout case keeps
working.

**Why.** `architecture.md` is blunt about it: there is no RLS, so a route that
forgets `requireSession()` has nothing underneath it to fail safe. That risk is
worth a test rather than a habit.

**Depends on.** Runs alongside everything.

| ID                 | Ticket                            | Notes                                                                                                                                                                                        |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E10-T1<br>`YEO-65` | Test harness (Vitest)             | There is currently no test runner in `package.json`. Everything else here is blocked on it.                                                                                                  |
| E10-T2<br>`YEO-66` | Auth boundary test                | Every route and server action rejects an unauthenticated caller. Ideally a test that enumerates routes and fails on a new unguarded one, rather than a list someone must remember to update. |
| E10-T3<br>`YEO-67` | Layout tests for the seed fixture | The Mary/Thomas/Rose/Walter chain is the case that breaks naive models — assert nobody is duplicated and generations rank correctly.                                                         |
| E10-T4<br>`YEO-68` | Relationship-derivation tests     | Half-sibling, step-parent, and the u1/u3 "no blood relation at all" case.                                                                                                                    |
| E10-T5<br>`YEO-69` | Accessibility pass                | Keyboard navigation of the tree, focus handling in the slide-over panel.                                                                                                                     |

---

## E11 — Encyclopedia presentation · `YEO-70`

**Outcome.** An entry is visually indistinguishable from a Wikipedia article:
Vector 2022 skin, full article chrome.

**Why.** Recognition. The author already knows how to read a Wikipedia page and
already knows what a blue link and an `[edit]` beside a heading do. Borrowing a
familiar interface is cheaper than teaching a new one — see the principle in
`product.md`.

**Depends on.** E11-T1 lands _before_ E1-T1, so the read route is built in the
right visual language rather than restyled afterwards. Everything else here
layers onto E1.

| ID                 | Ticket                                          | Notes                                                                                                                                                                  |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E11-T1<br>`YEO-71` | Visual foundation — type, colour, layout tokens | Serif headings (`Linux Libertine`, Georgia fallback) over sans body, `#3366cc` links, `#f8f9fa` panels, Wikipedia's measure and leading. Blocks E1-T1.                 |
| E11-T2<br>`YEO-72` | Vector 2022 article shell                       | Sticky header, collapsible left sidebar, centred content column. Collapses cleanly on a phone — reading on mobile is in scope.                                         |
| E11-T3<br>`YEO-73` | Pinned table of contents                        | Auto-generated from headings, pinned in the left margin, tracks scroll position. Needs stable heading IDs — shared with E11-T4.                                        |
| E11-T4<br>`YEO-74` | Section `[edit]` links                          | Opens the full editor scrolled to that section. **Not** true section-level editing — see the note in the ticket.                                                       |
| E11-T5<br>`YEO-75` | Person infobox                                  | Portrait, born/died, spouses, children — **derived from the tree record, never authored.** The one place this departs from Wikipedia on purpose.                       |
| E11-T6<br>`YEO-76` | Red links for entries that do not exist         | A red link is an invitation to write. Pairs with E2-T2 and E2-T5.                                                                                                      |
| E11-T7<br>`YEO-77` | Article tabs                                    | Article / Read / Edit / View history. No Talk tab — discussion is a non-goal.                                                                                          |
| E11-T8<br>`YEO-78` | Categories                                      | `categories` + `page_categories`, a picker in the editor, the footer bar, and listings at `/wiki/category`. The only ticket here that is a feature rather than a skin. |
| E11-T9<br>`YEO-79` | Hatnotes                                        | The italic "For other people named Rose, see..." line above the first paragraph.                                                                                       |

**Not in this epic.** Talk pages, `<ref>` footnotes, "Cite this page",
disambiguation pages beyond the hatnote itself.

---

## Sequencing

```
E11-T1 skin ── E1 wiki ──┬── E2 linking ──┐
                         ├── E5 images    ├── E8 search
                         ├── E11 chrome   │
                         └────────────────┘
E3 tree editing ── E4 dates ── E6 import ── E7 export
E9 ops        (independent, start E9-T1 now)
E10 quality   (E10-T1 early, rest alongside)
```

**First slice.** E11-T1 → E1-T1 → E1-T2 → E1-T3 → E1-T4. That is a wiki you
can write in, wearing the right clothes from the first commit.

**Second slice.** E3-T1 → E3-T2 → E3-T4 → E3-T5. That is a tree you can grow.

**Cheap and early.** E9-T1, E9-T5, E10-T1 — small, unblocking, and each one
removes a failure mode rather than adding a feature.
