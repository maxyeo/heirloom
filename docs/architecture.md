# Architecture

## Stack

| Layer          | Choice                        | Why                                                                          |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Framework      | Next.js (App Router)          | Server components mean the database is reachable without a separate API tier |
| Host           | Vercel                        | Free tier is sufficient; `output: "standalone"` keeps other hosts open       |
| Auth           | Auth.js v5, Google provider   | One-click sign-in for people who already live in Gmail                       |
| Database       | Postgres (Supabase free tier) | Used as _plain Postgres_, not as a backend-as-a-service                      |
| Query layer    | Drizzle + `postgres.js`       | Typed SQL, no ORM ceremony, no vendor client                                 |
| Tree layout    | dagre                         | Family trees are layered DAGs; dagre lays out layered DAGs                   |
| Tree rendering | React Flow (`@xyflow/react`)  | Pan, zoom, and edge routing for free                                         |
| Editor         | TipTap                        | WYSIWYG, because the primary author does not write Markdown                  |

## The security model

The single most important decision: **Supabase is used as hosted Postgres, not
as a backend-as-a-service.** The browser never talks to it, never sees a
project URL, and never holds an API key. All database access happens in server
components and route handlers, using a connection string held in Vercel's
environment.

This has a direct consequence: **there is no row-level security.** The app
connects to Postgres as a single role rather than as the signed-in user, so
RLS policies would have no JWT to act on. That is the correct trade for this
architecture, not an oversight — but it means the application layer is the
_only_ boundary.

So there is exactly one boundary, and it is `lib/session.ts`:

```ts
const session = await requireSession(); // throws if not signed in
```

Everything that touches the database goes through it. `proxy.ts` provides a
second, coarser layer: every route is private by default, and the matcher
enumerates the handful of public exceptions rather than the private ones. A new
page is therefore protected the moment it exists.

`app/api/search/route.ts` is the first route handler in this application that
is not Auth.js's own, and it goes through the same single boundary by its
401-returning flavour — `requireSessionOr401`, which had existed unused since
E10-T2 for exactly this. It guards _before_ it reads the query, so that a
caller with no session cannot probe what the corpus holds by watching which
queries are rejected differently. Its response carries
`Cache-Control: private, no-store`, which is a separate question from anything
Next caches: a `GET /api/search?q=grandmother` left in a shared laptop's disk
cache would be a family's names sitting outside the boundary, the same way
`YEO-86` found image URLs to be.

### Access control

Google sign-in establishes _identity_, not _authorisation_ — anyone with a
Google account can complete the handshake. `ALLOWED_EMAILS` is the entire
membership model, checked in the `signIn` callback. Anyone not on the list is
rejected at the door.

Optionally, leaving the Google OAuth app in **Testing** mode in Google Cloud
Console adds a second gate: only listed test users can complete the flow at
all. Because the app requests only `openid`/`email`/`profile`, it never needs
Google's app verification. The 7-day refresh-token expiry that Testing mode
imposes is irrelevant here — Google is used for identity only, never to call
Google APIs on a user's behalf.

### Images

Photographs are inside that boundary too, and putting them there was a
decision rather than a default (`YEO-86`).

Blob stores are created public or private. A public store serves every object
at a permanent, unauthenticated URL, and the only thing protecting a family
photograph is that the URL is long and nobody has guessed it. That is how most
photo hosting on the internet works, and for one release it is how this worked
too: E5-T1 shipped `access: "public"` and wrote the trade down honestly rather
than leaving it to be discovered.

The trade did not survive being looked at. Everything ordinary that moves a
URL moves the image with it — a browser history on a shared laptop, a link
pasted into a family chat, a referrer header, a bookmark sync, a page
forwarded to a relative who is not on the list. None of those are exotic for a
wiki whose entire purpose is to be shown to relatives, and the failure is
silent and permanent: nobody finds out, and there is no revocation short of
deleting the file. The counter-argument — that these are photographs, not
credentials — is true and does not reach the point. It argues about how bad
the exposure is, not about whether the deployer expected it, and a family that
put its wiki behind a list of email addresses plainly expected the photographs
to be behind it too.

So the store is **private**, and `lib/storage.ts` hands out **signed URLs that
expire fifteen minutes after they are minted**. Two things follow, and the
second is the one that matters:

- Nothing reaches an image without asking this application first, and this
  application requires a session.
- A leak is time-boxed. The URL sitting in somebody's chat history stopped
  working the same afternoon. That is the difference between a mistake and a
  permanent exposure, and it is why "unguessable is basically fine" was the
  wrong answer even though the photographs are not secrets.

What it costs is that an image URL is no longer a durable thing anybody can
write down. The expiry itself, and the contract that follows from it, are in
[The storage seam](#the-storage-seam).

#### What the upload endpoint takes out of a photograph

The boundary above protects the picture. It does not protect what is written
in the margins of the file, and on a family wiki the margins are the problem:
family photographs are phone photographs, and a phone photograph taken at home
carries the coordinates of the home in it, to a few metres, invisibly in every
program that displays it.

The site is private, but the _file_ does not stay behind the site — it is
handed to a storage host, fetched by a browser, saved by a relative,
forwarded, backed up. Each of those is fine for a photograph and none of them
is fine for an address. So `lib/image-metadata.ts` removes the location on the
way in (`E5-T2`), once, before anything else can copy the file somewhere this
code does not run. Out come the Exif GPS directory, the XMP and IPTC blocks
that carry coordinates as text, and the vendor maker note that cannot be
parsed well enough to be trusted.

That last list is per-container rather than per-format, and one of the four
formats is worth calling out because the obvious reasoning about it is wrong.
**A GIF has no Exif block, and that does not mean it has nowhere to put a
location.** GIF89a defines an Application Extension — a labelled block of
vendor data — and it is the documented place an XMP packet goes; `exiftool`,
ImageMagick and Photoshop's "Save for Web" all write one. A GIF made from a
phone video by a tool that carries the source metadata across arrives with
`exif:GPSLatitude` in it. So a GIF is walked like the others, and its
application, comment and plain-text extensions are dropped, keeping only what
draws and times the picture: the colour tables, the image blocks, the graphic
control extensions, and the Netscape loop count without which every animation
would play once and stop.

One rule runs through all four containers, and it is the one this code got
wrong more than once: **a block is kept for its shape, never for its label.**
A label is a claim the file makes about itself. A graphic control extension is
four bytes of timing, but the label sits in front of an ordinary
variable-length chain, so keeping one on its label alone keeps whatever that
chain holds — coordinates, or as many kilobytes as the upload cap allows. The
same held for a JPEG `APP0` kept on its marker, and for a PNG chunk kept for
_not_ appearing on a blocklist. Blocks with a mandated size are now checked
against it; the rest are on allowlists of the types each format actually
defines.

That guarantee is deliberately narrower than "nothing chosen reaches the
store", which is not available to any image scrubber and should not be
implied. An image is arbitrary bytes: a palette is chosen values, a colour
profile is a binary blob kept for colour accuracy, and a megapixel of pixels
will carry a megabyte of anything. What is promised is that **no metadata
block reaches the store unread** — everything that is not pixels, palette or
profile is dropped, scrubbed, or matched against a shape with no room in it —
and that location metadata is removed from all four formats, everywhere any
of them defines a place to put it.

**Orientation stays**, and that is the reason this is byte-level surgery
rather than a three-line deletion. A phone stores its pixels the way the
sensor delivered them and writes "rotate this" into the same Exif block the
coordinates are in; delete the block and every portrait photograph in the wiki
lies on its side permanently, with the information needed to fix it destroyed
on upload. The scrub is length-preserving and rewrites no offset, so the
capture date, the camera and the colour profile survive too — a family archive
is precisely the place where "when was this taken" is worth keeping.

Metadata that cannot be parsed is dropped whole rather than passed through,
and a file whose container cannot be walked is refused outright. Both are the
same rule: this code does not forward bytes it could not read.

### Entry HTML

Entry bodies are the one place authored markup reaches the browser. TipTap
writes them into a `text` column and the read route (E1-T1) will render them
through `dangerouslySetInnerHTML`, so `lib/sanitize-html.ts` reduces them to an
allowlist — the E1-T2 toolbar and nothing wider — on **write and on read**.

Both ends, not one. Sanitising only on write trusts every row already in the
table, including whatever a seed script or a SQL console put there.
Sanitising only on read leaves the stored value hostile, so the next consumer
— search indexing, diffs, export — inherits the same bug. The function is
idempotent, so the second pass costs a parse and nothing else.

This matters more here than it would elsewhere. With no RLS underneath and no
CSP over the top, the allowlist is the whole defence.

#### The one attribute whose _value_ is checked

`img[src]` (E5-T3). An allowlist of tag and attribute names cannot say _which
addresses_ a picture may come from, and for photographs that question is the
whole of the criterion: an `<img>` is a fetch the reader's browser makes on
behalf of whoever wrote the body. So `isStoredImageSrc` decides, and an `img`
that fails it is dropped **whole** rather than stripped of its `src` — the
difference between a foreign image disappearing and a permanently broken
picture icon sitting in the entry.

What it permits is this application's own image route and nothing else, which
is the same shape [Links between entries](#links-between-entries) takes and is
what [the storage seam](#the-storage-seam) means by _"the sanitiser allowlist
never needs to name a storage host"_. An absolute URL is refused even when it
names this host: a body that reaches out to the network at render time leaks
the reader's address and `Referer` to whoever wrote it — an ordinary tracking
pixel — and this wiki is behind an email allowlist precisely so that reading it
is not observable from outside. A `data:` URI is refused too: megabytes of
base64 copied into every revision, with no key for E5-T5 to sweep and nothing
for the export to fetch.

The check is `imageKeyFromHref`, which is also what `lib/entry-images.ts` asks
to build the export and what E5-T5's orphan sweep will ask from the other side.
All three agree about what "one of ours" means because there is one function
that says.

The coupling to the editor runs the same way. `EntryImage` in
`lib/editor-extensions.ts` is a node of this repository's own rather than
`@tiptap/extension-image`, and its parse rule is _the same predicate_ — so
pasting a page full of images from the web drops them at the point of paste
rather than showing them to the author and deleting them on save. The editor
must not be able to emit anything the allowlist discards; that rule now covers
values as well as tags.

### Links between entries

A link from one entry to another is stored as a plain, **site-relative**
`<a href="/wiki/rose-hall">` — no origin, no scheme, and no marker of any
kind. That is not a simplification; it is the only shape available. The
allowlist above permits exactly one attribute on an `a`, and it is `href`, so
a `class` or a `data-` attribute saying "this one is internal" would be
stripped on the next save. The href is the marker.

Two things follow, and both are deliberate:

- **Bodies outlive the domain they were written on.** An absolute href would
  keep resolving after a move, pointing at somebody else's server, and it
  would do it silently.
- **Resolution happens at render time, against `pages.slug`.** Nothing is
  denormalised, so renaming or deleting an entry needs no sweep over stored
  HTML. A link to an entry that no longer exists is simply one that does not
  resolve — which is what E11-T6 renders red. The editor's link panel reads
  the same hrefs back the same way (`lib/entry-links.ts`, E2-T5), so an author
  who opens a broken link is told it is broken rather than shown an address.

`lib/red-links.ts` is that resolution (E11-T6). It scans a body **once** for
internal links, asks `findExistingSlugs` **once** which of them exist, and
rewrites only the anchors that lead nowhere — red, tooltipped, and pointing at
the create flow pre-titled with the link's own text. The query count is a
property of the shape rather than a rule to remember: the scan is separate
from the lookup, the lookup takes a set, and the rewrite is synchronous, so
there is no `await` inside it for a per-link query to hide in. A body with no
internal links reaches the database not at all.

Three consequences worth stating, because each is load-bearing:

- **It runs after the sanitiser, never before.** The rewrite adds `class` and
  `title`, which the allowlist strips. Sanitising afterwards would undo the
  feature silently, so `lib/red-links.test.ts` asserts it.
- **Nothing is stored.** An entry that gets written turns every link to it
  blue on the next render, with no sweep over stored HTML and no edit to the
  linking entry. Renames and deletions run the same way in reverse.
- **`entryLinkProps` is the shared decision.** Callers that render links as
  React elements rather than as a chunk of HTML — the person infobox (E11-T5)
  — go through it too, and collect their slugs into the same one query. What a
  red link _is_ has one description.

### Hatnotes

The indented italic line above the lead paragraph — _"For other people named
Rose Whitfield, see …"_ — is E11-T9 (`YEO-79`), and it is the cheapest possible
answer to "am I reading about the right person". Repeated names are the norm in
families rather than the exception, so the doubt is common and it occurs
exactly where this line sits.

**It is a column, not the first paragraph of the body.** A hatnote points
_away_ from the entry, which is what makes it apparatus rather than prose.
Stored inside `body_html` it would be indistinguishable from content: the
outline would treat it as a block, `ts_headline` would offer it as the snippet
that answers a search, and an author could not edit the lead without stepping
over it. `pages.hatnote` and `revisions.hatnote` keep "this is apparatus" a
fact about the data. It is deliberately absent from `pages.search_vector` for
the same reason — a hatnote names _other_ entries, so indexing it would make
every same-named person a match for every other.

**Text and links, enforced by the one allowlist.** The acceptance criterion is
"plain text plus links; not a full editor surface", and the obvious
implementation is a second `sanitize-html` options object with
`allowedTags: ["a"]`. That is a second allowlist, and a second allowlist is a
second thing to tighten — the failure being that a tag disallowed in a body
goes on being allowed in the line above it. So `normaliseHatnote`
(`lib/hatnote.ts`) runs `sanitizeHtml`, walks its output turning block tags
into spaces and dropping every inline tag but `a`, and runs `sanitizeHtml`
again. The narrowing is a **transform** rather than a policy: it can only
remove from what the allowlist already permitted, and the second pass means the
value is sanitiser output whatever it was given — the identical argument
`lib/article-outline.ts` makes for its own two passes. It runs on write and
again on read, like the body, for the reasons "Entry HTML" gives above.

The editor side is the same subtraction: `createHatnoteExtensions` is the
body's StarterKit configuration with bold, italic, lists, headings and
`hardBreak` off, one toolbar button (the body's own Link control, derived
rather than restated), and Enter refused. So the field cannot produce markup
the stored form would have to flatten away — which is what "not a full editor
surface" has to mean if it is to mean anything. **No `[[wiki syntax]]`**:
`lib/entry-links.ts` rules it out on docs/product.md's No-Markdown principle,
and a hatnote is not the place to reintroduce it.

**Two hatnotes, and they compose by stacking.** The manual one is editorial and
about this entry; the automatic one is a fact about `individuals`, derived at
render time and stored nowhere. Both render, the author's first, each in its
own `.hatnote`. Neither suppresses the other, and both directions of
suppression are wrong: hiding the automatic note when an author wrote one hides
a collision the author _cannot have known about_ — the namesake may have been
added years later by somebody else — and hiding the author's note throws away a
sentence somebody deliberately wrote. When the lookup finds nobody there is no
automatic note; when there is neither, **no element is rendered at all**, which
`components/ArticleHatnote.test.tsx` asserts, because an empty wrapper leaves a
margin above the lead and nobody notices for months.

**The collision lookup is one indexed query.** `findNamesakes`
(`lib/namesakes.ts`) matches on `surname = ? AND given_name = ?`, which is
exactly the pair `individuals_surname_idx` leads on, and it brings the entry
addresses back through a `left join` onto `pages` rather than asking per name.
The match is exact where people search is tolerant, and that is deliberate: a
hatnote is a claim, and "for other people named Rose Whitfield" is false if the
other person is a Rosa. Tolerance also could not be a `WHERE` predicate —
`nameKey`'s substitutions run in TypeScript — so a tolerant version would have
to read every individual on every entry render, which is the scan this avoids.
The namesakes' slugs and the author's hatnote's links join the body's in the
_one_ `findExistingSlugs` call the render already makes, so a hatnote costs the
page no extra round trip and a namesake with no entry comes out as a red link
inviting somebody to write one.

**It is versioned.** `revisions.hatnote` exists because "Nothing is ever
destroyed" (docs/product.md) is a promise about authored text. Without it,
restore would put the paragraphs back and leave the line above them as the last
save left it — succeeding, and being lossy, with nothing reporting it. The
no-op rules in `savePage` and `restoreRevision` compare it too, so a
hatnote-only edit is a change; and `diffEntryContent` gives it a block kind of
its own, so that change is visible in a comparison rather than reported as "No
change to the rendered content".

### Secrets

`DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, and `STORAGE_TOKEN` live
in Vercel's environment and never in the repository. `AUTH_SECRET` deserves particular
care: it signs session cookies, so anyone holding it can forge a session as
any allowed user and bypass Google entirely.

The repository is public. That is safe because nothing sensitive is in it —
and because everything personal (the allowlist, the site title) is
configuration rather than code, which is the same property that makes the
project deployable by someone else.

## Data model

A family tree is not a tree. `person.parent_id` collapses immediately on real
families: two parents, remarriage, half-siblings, adoption, step-parents,
unknown parents. The model here follows GEDCOM's core insight — **the union is
a first-class entity**, and children belong to a union rather than to
individuals.

```
individuals ──┬─< unions >─┬── union_children >── individuals
              │            │
        partner_a_id  partner_b_id
```

Three tables (`individuals`, `unions`, `union_children`) cover every case
without special-casing:

- **Remarriage** — a person is a partner in more than one union
- **Half-siblings** — children of different unions sharing one partner
- **Adoption** — an attribute of the child↔union link, not a different shape
- **Unknown parent** — both partner columns are nullable, so you never have to
  invent a placeholder person

Crucially, **relationship labels are never stored.** "Half-sibling",
"step-mother", "cousin", and "in-law" are all derived from two recorded facts:
who partnered with whom, and who was born into which union. This is why the
model survives contact with a real family — you never have to anticipate a
relationship type, because you are not storing relationship types.

### The worked example

The seed fixture (`db/seed-family.ts`, written to the database by
`db/seed.ts`) is modelled on a real family, because invented test data only
exercises the easy cases. Names are placeholders; the shape is the point.

```
[Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
          │              │             │
       1 child      2 children    8 children
```

- Mary married Thomas; they had one child; Mary died
- Rose married Thomas; they had two children; Thomas died
- Rose married Walter; they had eight children

What this exercises:

- Two people (Thomas, Rose) each appear in two unions — the case `d3-tree`
  cannot draw, because it assumes one parent slot per node
- Half-siblings arise on _both_ sides of the chain
- u1's child and u3's children **share no parent at all.** They are not blood
  relations; they are connected only by the chain of remarriages. u2's children
  are the only people related by blood to both ends

If the tree renders this correctly, the hard part works. That sentence is
asserted rather than hoped for: the fixture is a plain value with no database
import, so `lib/tree-layout.seed.test.ts` lays out these very rows and checks
that nobody is duplicated and that generation still means rank.

### The one invariant the model does not enforce

Three tables and two nullable columns express every family shape without a
special case — but nothing in the schema stops `union_children` from being
given a row that makes somebody their own ancestor. There is no constraint
that could: the check is a walk over `unions` and `union_children` together,
and Postgres has no cheap way to state it.

That matters more than a normal data-quality rule, because the graph is walked
as though it were acyclic. `lib/tree-layout.ts` hands it to dagre, which ranks
a cycle by giving up on it, and `lib/person-detail.ts` and `lib/ancestry.ts`
walk it directly. So a single bad row is not a wrong-looking panel; it is
`/tree` failing to render, for everybody, with no way back through the
application.

The rule therefore lives in the application, in exactly one place:
`lib/save-child.ts`, which is the only code that writes a `union_children`
row. It runs `ancestryCycle` against a read taken **inside its own
transaction** rather than trusting whatever the browser last loaded — the same
re-read-and-re-check pattern `lib/remove-from-tree.ts` and `lib/save-union.ts`
follow. The forms filter their own pickers with the same function so the
impossible options never appear, but that is a courtesy and not the boundary.

The walk itself is pure — `FamilyGraph` in, a set of ids out — which is what
lets the cases that matter (a direct loop, a multi-generation one, and the
diamond where cousins marry and two lines of descent legitimately rejoin) be
asserted with no database at all.

### Date precision

A `date` column can only hold an exact day, and genealogical sources routinely
do not supply one — "about 1890", "before 1920", a year read off a headstone.
Every date column therefore has a `date_qualifier` sibling
(`exact` / `about` / `before` / `after`, defaulting to `exact`):
`individuals.birth_date`, `individuals.death_date`, `unions.start_date`, and
`unions.end_date`.

Two consequences worth naming. Imprecision no longer has to hide in `notes`,
where nothing can query or format it; and the four values are exactly GEDCOM
5.5.1's date modifiers, so `ABT`/`BEF`/`AFT` survive a round trip through
import and export instead of being silently discarded.

A range survives too, in a second pair of columns; see
[Ranges, and the columns that hold them](#ranges-and-the-columns-that-hold-them).

A qualifier answers only half the question, though, and E4-T2 (`YEO-39`) added
the other half. "How far can this be trusted" is not the same question as "how
much of a date did the source actually give" — a headstone gives a year, a
census gives a year, a parish register gives a day, and none of those is
`about`. So every date column has a **second** sibling, `date_precision`
(`day` / `month` / `year`, defaulting to `day`).

The storage convention it establishes: a coarse date is stored on the **first
day of the month or year it names**, and that day is an _anchor_, never an
assertion. Nothing reads it as a day on its own — `formatQualifiedDate` prints
`1890`, `isImpossibleOrder` widens it back out to the whole year before
comparing, and a GEDCOM export will emit `1890`. Without the column, a year off
a headstone had nowhere to go but 1 January, and every reader downstream then
repeated that invented day as though somebody had recorded it.

That pair is what lets the date field be a single text box. `lib/parse-date.ts`
turns `about 1890`, `c. 1890`, `before 1920` or `12 March 1890` into the three
columns; `formatQualifiedDate` turns them back into the same sentence, so the
round trip closes and an edit form can prefill free text without a second
formatter. An author never picks a qualifier from a dropdown before typing a
date — see `components/DateField.tsx`.

#### One formatter, and why it is one

`lib/format-date.ts` (E4-T3, `YEO-40`) is the only module that turns those
columns into words, and every surface that shows a date goes through it: the
tree node label, the detail panel, the removal dialogue, the date field's echo
and the edit form's prefill. Formatting a date is easy, which is exactly the
problem — easy things get rewritten locally, and the local rewrite is where
somebody reaches for `person.birthDate` alone and publishes the anchor day as
a birthday.

Two properties the module enforces rather than documents:

- **`precision` is a required parameter.** It briefly had a `day` default, and
  the cost was a bug that shipped green: call sites that forgot the third
  argument rendered a year off a headstone as "1 January 1890", in the voice
  of a recorded fact. Every fixture at the time used day precision, so no test
  disagreed. Requiring it moves the omission from something a reviewer has to
  catch to something the compiler will not build.
- **A missing date renders as nothing.** Not "unknown", not a dash.
  `formatQualifiedDate` returns `null` and `formatLifespan` returns `""`, so
  every caller omits the element. Most of a nineteenth-century record is
  missing; a column of em dashes reads as a defect in the tree rather than as
  the honest limit of what the source said.

`formatLifespan` lives there too — the years under a name, `1899–1960` or
`b. about 1890` — and carries the qualifier for the same reason the panel
does. `b. 1890` and `b. about 1890` are different claims, and the node is the
most-read surface in the application to be making the wrong one on. It takes
no precision, and that is not the same omission: the anchor convention puts
the year in the same four characters at every precision, so a year is the one
part of a stored date that reading back can never invent.

#### Ranges, and the columns that hold them

`date_qualifier` has four members and every one describes a single point with
a fuzzy edge. GEDCOM has two forms that describe two points — `BET 1890 AND
1900`, `FROM 1912 TO 1918` — and until `YEO-88` they had nowhere to go. The
parser refused them rather than guess, which was correct in isolation and left
real dates on the floor: a date inferred from a census window or a parish
register span is usually written as one.

Three answers were on the table.

- **Collapse onto the lower bound.** `BET 1890 AND 1900` stored as `after
1890`, the upper bound surviving only on the import report. No schema
  change, no migration, no new column, and a decision written down rather than
  hidden. It was built, and it was rejected — because `AFT 1890` and `BET 1890
AND 1900` become the same row, nothing downstream can tell them apart, and
  the loss is per-import rather than per-row, so a year later there is no way
  to ask which dates were narrowed.
- **A fifth qualifier**, `between`, with the far endpoint beside it. Narrower,
  and it lets the two columns contradict each other: `('between', no
endpoint)` and `('exact', an endpoint)` are both writable and neither is a
  state the world has.
- **Widen the schema.** What it does.

Every event now has five date columns rather than three: `birth_date`,
`birth_date_qualifier`, `birth_date_precision`, `birth_date_upper`,
`birth_date_upper_precision`, and the same shape for `death_date`,
`unions.start_date` and `unions.end_date`. `_upper` reads as "the upper bound
of this date", which is what keeps `unions.end_date_upper` from being a
sentence about two different ends.

`birth_date_upper` is null on a date that is one point, which is every row
written before the column existed — so the migration is additive and changes
the meaning of nothing. `birth_date_upper_precision` is `not null default
'day'` for the reason the other precision columns are: it is only read beside
a non-null upper date, and "not a range" is already said once.

**The qualifier gained no member, and a stored range carries `exact`.** That
is not a dodge. `exact` already means "the value is as given, widened by its
precision" — `dateRange` in `lib/field-input.ts` turns `exact` plus a
year-precision 1890 into `[1890-01-01, 1890-12-31]`. With an upper bound the
same sentence produces `[1890-01-01, 1900-12-31]`. One question, four
members, unchanged; whether a date is one point or two is answered by a
column being null, which is where a structural fact belongs.

**Both endpoints carry their own precision, and it matters.** `BET MAR 1890
AND 1900` is two sources — a baptism in March, a census in 1900 — and one
precision for both would have to throw away the March or invent one for 1900.
So `formatQualifiedDate` renders that row as `between March 1890 and 1900`,
each end at what its own source actually gave.

The validator is the surface that gains most. `isImpossibleOrder` now compares
genuinely two-sided intervals: a death recorded `BET 1890 AND 1900` has a
latest of 1900-12-31 rather than of nothing at all, so "born 1950, died
between 1890 and 1900" is refused where the collapsed reading — `after 1890`,
unbounded above — could never have refused anything. Adding an upper bound
only ever widens `latest` and never moves `earliest`, which is why every
existing row keeps passing every check it passed before.

The cost is width, and it is real: seventeen columns on `individuals`, sixteen
on `unions`, eight of them inert on almost every row, and a formatter and a
validator that both take five values per date instead of three. The trade
accepted is that a range read out of somebody's file is the range that comes
back out of it.

`INT 1890 (from baptism record)` is the one date form still narrowed on the
way in. The date is stored as `about 1890`, because `INT` says the submitter
_inferred_ it and `exact` would claim a precision the file itself disclaims;
the interpretation phrase is prose, has no column, and is reported.

### What GEDCOM has that this schema does not

The data model above was chosen against GEDCOM's own insight, so E6-T2
(`YEO-47`) — the mapping in `lib/gedcom-map.ts` — was expected to be
near-mechanical, and mostly is: `INDI` is an `individuals` row, `FAM` is a
`unions` row, `CHIL` is a `union_children` row, `HUSB`/`WIFE` are the two
partner columns, and since `YEO-88` every date form the format has arrives in
columns that already fit it.

The ticket asked for the places where it is _not_ mechanical to be written
down rather than worked around. There are six, and none of them is an
accident of the mapping — each is a thing the format records and this schema
has nowhere to keep. They are listed cheapest-to-fix last.

1. **A person must have a first name here and need not have one there.**
   `individuals.given_name` is `not null`, because every surface in this
   application labels a person with it. `1 NAME /Smith/` — a woman known only
   by a married surname — is ordinary GEDCOM, and an `INDI` with no `NAME` at
   all is how a program records somebody known only to have existed. The
   mapping records `"Unknown"` and reports it every time. Skipping those
   people was the obvious alternative and is much worse: they are in the file
   _because_ they are somebody's parent, so dropping them deletes the edge
   that was the only reason to record them. **The real fix is a nullable
   `given_name`**, and it is a large one — every formatter, label and search
   path assumes the column is there.
2. **A person has one name here and many there.** GEDCOM's `NAME` repeats:
   a birth name and a married name, an anglicised spelling, an alias. The
   first is kept and the rest are reported. There is no column, and adding one
   means a `names` table, which is a bigger change to the model than anything
   in E6.
3. **A union has no place.** `individuals` has `birth_place` and
   `death_place`; `unions` has neither, so `MARR.PLAC` — one of the most
   common lines in a real file — is read and then dropped, with a report line
   each time. It is deliberately **not** folded into `unions.notes`: the date
   precision section above spent its length arguing that facts do not belong
   in `notes` "where nothing can query or format it", and a wedding's parish
   is a fact of exactly that kind. This is the cheapest of the six to fix —
   two columns and a form field, no reshaping of anything.
4. **`PEDI` is written on the child and the edge is written on the family.**
   `union_children.relation` is one column that needs two records to fill it:
   `CHIL` under `FAM` says the link exists, `PEDI` under the child's own
   `FAMC` says what kind it is. This is not a schema gap so much as a
   reminder that our one-row-per-link shape is tidier than the format's, and
   it did cost something — the parser had never looked at a `FAMC`'s children
   at all, so every sub-tag under one was falling through without even
   reaching the unknown-tag list. E6-T2 fixed that hole as well.
5. **`union_end_reason` has a `death` member and GEDCOM has no tag for it.**
   A marriage ends when a partner dies, and no file records that as an event
   of the family — it is an event of the person. So the mapping infers it, and
   stores **no end date** with it: the date is already recorded once, on the
   person who died, and a copy on the union would be a second thing to correct
   forever. `validateUnion` permits a reason without a date and refuses only
   the reverse, which is what makes the inference safe.
6. **`unions.sequence` has no GEDCOM equivalent whatsoever.** See
   [Ordering](#ordering) below for what the column is for; the mapping derives
   it from date order with file order behind it. Nothing is lost here — there
   was never anything in the file to lose — but it is worth knowing that the
   one column in these three tables with no counterpart in the format is the
   one that carries the story ordering, and it will not survive a round trip
   through anybody else's program.

Findings one, two and three are the only ones that lose data, and all three
lose it _with a report line_, never silently. Nothing in this list was worked
around in the mapping.

### Ordering

Unions sort by `sequence` first and `start_date` second. In older generations
exact marriage dates are often lost while the _order_ is remembered perfectly
well ("she remarried after he died"). Sorting on dates alone would silently
scramble the story whenever a year is missing.

### Import provenance, and why a second import of the same file is refused

`lib/gedcom-map.ts` mints a fresh id for every record on every parse, so
nothing about a mapped row says whether the bytes it came from have gone in
before. Before `YEO-89`, that made importing the same file twice a second
complete copy of every person, union and child link — silently, because a
doubled tree looks exactly like data until somebody notices the population
has strangely doubled.

The fix is a ledger, `gedcom_imports`, and a foreign key from each of
`individuals`, `unions` and `union_children` back to it (`import_id`, nullable
— null is every row typed by hand, and every row that existed before this
column did). `lib/gedcom-import.ts` writes a row into the ledger, keyed on the
uploaded file's SHA-256 digest, inside the same transaction as the three
tables and before any of them.

**The guard is the table's unique index on `digest`, not a check anywhere in
this application's code.** A `select`-then-`insert` has a race in the middle —
two requests can both see no prior row — and a second browser tab, a retried
request, or a back button landing on a stale preview all find it. The unique
constraint has no such gap: whichever transaction's insert loses is refused by
Postgres itself, and the loser's entire write, ledger row included, rolls back
with it. That is what makes the guard survive exactly the callers that could
otherwise reach it — it does not depend on the route remembering to ask first,
because Postgres asks regardless.

A second import of a digest already in the ledger is **refused**, not merged
and not used to replace what is already there. Both alternatives need a
stable per-record identity to reconcile against — most real GEDCOM files carry
none (no `_UID`, no `REFN`), and inventing one from a name and a pair of dates
is a guess that can silently weld two different cousins into one person; a
stable identity to match on is the honest fix for merging, and it remains
future work, not something this table attempts. Replacing is worse than doing
nothing: rows an import writes are exactly the rows somebody goes on to edit
by hand, so "replace" would mean deleting somebody's edits to make room for
bytes the tree already has. Refusing needs no identity model and destroys
nothing it did not write itself, and `app/api/import/route.ts` answers `409`
naming the date and what the earlier import added, so a reader who did it on
purpose — a second tab, a slow connection retried — learns their first attempt
already landed rather than being left to guess. The policy is also stated
before that: `components/GedcomImport.tsx` reads the same ledger on the
preview request and says, at the point of confirm, either that importing this
file is recorded and a repeat will be refused, or that it already has been.

What this does not solve, and is not trying to: **a different file describing
the same people still duplicates them.** There is still no identity to match a
record in one file against a record in another — only a file against its own
past self, by the bytes it is made of. Merging duplicate _people_ is a
separate, harder problem from the duplicate _unions_ `lib/merge-unions.ts`
already reconciles, and it is out of scope here for the same reason merging an
import into a populated tree is (`docs/epics.md`, E6, _Not in this epic_).

## Rendering

Generation maps to dagre rank. Unions are laid out as their own small nodes,
which is what allows a twice-married person to sit between both of their
unions rather than being duplicated on the canvas.

**Layout is computed, never stored.** There are no x/y coordinates in the
database. This is a product decision as much as a technical one — see
`product.md` — and it also removes an entire class of work: no re-layout when
someone inserts a grandparent, no persistence, no drag state, no way for an
editor to shove the family off-screen with no undo.

Scale is small: a family tree is hundreds of people at most, so the entire
graph is loaded in one query and laid out client-side. No pagination, no
virtualisation.

### The one client-side read

Everything above is rendered on the server. There is exactly one place in this
application where the browser fetches data for itself, it was added by E8-T3
(`YEO-57`), and it is worth writing down _why it is the only one_ so that the
next person to want a second has the argument in front of them.

The header's search box asks as you type. That cannot be a server action, for
four reasons that all point the same way: actions are POST and the router
**queues** them, so eight keystrokes become eight round trips that must each
finish before the next starts; an action's transition cannot be cancelled,
where a GET can be abandoned with `AbortController`; an action's reply is an
RSC payload carrying whatever it revalidated, which is a router tree paid for
on every keystroke to fetch ten rows; and a search is a _read_ of a URL, which
is what a GET is for. So `app/api/search/route.ts` is the first route handler
in this codebase that is not Auth.js's own.

The pieces, and where each decision lives:

- **`lib/search-endpoint.ts`** is the contract both ends import — the URL, the
  parameter name, the limits, the payload shape, and the narrowing of what
  comes back. One module, because a disagreement across a network boundary is
  not a type error: it typechecks on both sides and is wrong in the middle.
- **The handler calls the two backends E8-T1 and E8-T2 already built** —
  `searchEntries` (`lib/pages.ts`, Postgres full-text) and `searchPeopleByName`
  (`lib/people.ts`, ranked in TypeScript) — rather than querying around them.
- **200ms debounce**, which is roughly one request per _word_ for a fluent
  typist and still below the ~250ms at which an interface starts to feel like
  it is thinking. It is not a nicety: `searchPeopleByName` reads the whole
  `individuals` table per call, and this ticket put it on a per-keystroke path.
- **A two-character floor, enforced at both ends.** The box declines to ask,
  and the handler declines to answer. The client is not the only caller — this
  is a GET any signed-in person can issue, with no debounce in front of it —
  and a rule that exists to bound cost has to live where the cost is paid.
- **Staleness is decided by the question, not by a counter.** The payload
  echoes back the query it answers, and `lib/suggestion-state.ts` discards any
  response that is not the question currently in the box. That is strictly
  better than a sequence number, because typing `cat` → `cats` → `cat` leaves
  the _first_ response a correct answer that a sequence guard would throw away
  and then re-ask for.
- **Five per group in the dropdown, twenty on `/search`**, and the difference
  is disclosed rather than hidden: every answer ends with a row leading to the
  full page. The handler asks each backend for six and truncates, which is how
  it can tell "exactly five matched" from "five of forty".

What deliberately did _not_ happen: no client-side cache, no shared query
layer, no data-fetching library. One `fetch` in one component does not need
one, and adding the abstraction here is how the next four reads get written on
the client instead of the server.

## What gates a merge

`.github/workflows/ci.yml` runs on every push and every pull request, in two
jobs that run concurrently. Everything in this table is a gate: red blocks the
merge.

| Job        | Runs                                                     | Environment                       |
| ---------- | -------------------------------------------------------- | --------------------------------- |
| `check`    | `format:check`, `typecheck`, `lint`, `npm test`, `build` | Deliberately empty                |
| `database` | `db:migrate:test`, `npm run test:db`                     | A throwaway `postgres:17` service |

**Nothing else gates a merge.** The two scheduled workflows — `keep-alive.yml`
and `backup.yml` — report by opening an issue rather than by failing a check on
somebody's branch, because neither says anything about the commit being merged.
There is no end-to-end suite and no deploy-preview gate, and `async` Server
Components are not unit-testable at all, so that ground is uncovered rather than
covered somewhere else. See docs/testing.md.

The two jobs are separate for a reason worth not undoing. `check` has no
`DATABASE_URL` and no `AUTH_*`, and that is exactly what makes its `npm run
build` step prove a build needs no live database — `db/index.ts` connects
lazily behind a Proxy so that it does not. Attaching a Postgres service to that
job would put a reachable database in the build's environment and quietly
retire the guarantee, since the build would go on passing either way. So the
database tests get a job, and a database, of their own.

Both halves of the test suite gating a merge is recent. `npm run test:db` ran
in no pipeline for a long time, and the cost was not the coverage gap — it was
that an unrun suite began shaping the code written against it, with two tickets
extracting modules specifically so their logic would land in the suite that
_was_ run. A suite that gates nothing still reads as "checked". The full
account is in docs/testing.md rather than repeated here.

Enforcement past the workflow file is GitHub's, not this repository's: both
jobs have to be listed as **required status checks** for `main` under Settings
-> Branches before a red run actually blocks the button. The workflow is what
makes the signal exist; branch protection is what makes it a gate.

## Deployment and migrations

`vercel.json` disables git deployments for every branch except `main`, so a
production build is only ever a merge. That build runs migrations first:

```
buildCommand: npm run db:migrate:deploy && npm run build
```

The ordering is the design. Applying migrations _after_ a deploy leaves a
window in which the new code queries columns that do not exist yet; applying
them before means the schema is always at or ahead of the code. And because
`&&` short-circuits, a migration that fails fails the build, and a failed
build is never promoted — so there is no deploy that assumes a migration
which did not happen.

Two consequences worth naming rather than discovering:

- **Rolling back a deployment does not roll back the database.** Vercel's
  instant rollback restores code only. Migrations should therefore be
  additive — add a column, backfill, stop reading the old one, drop it in a
  later release — so that the previous build still runs against the new
  schema.
- **Two merges in quick succession build concurrently.** Drizzle's migrator
  takes no advisory lock, so overlapping builds could in principle apply the
  same migration twice. At this project's rate of change the honest mitigation
  is to not merge twice in a minute.

Migrations use the _session_ pooler or direct connection (`MIGRATE_DATABASE_URL`,
port 5432), not the transaction pooler the app uses. A transaction pooler hands
out a different backend per transaction, which is right for serverless request
handlers and wrong for DDL.

`MIGRATE_DATABASE_URL` falls back to `DATABASE_URL` when unset, which is right
locally and wrong in production — and silently so, since ordinary additive DDL
usually succeeds over the transaction pooler anyway. `db/migrate.ts` therefore
logs which variable it used and against which host (never the password), so a
missing variable shows up in the first build log rather than in a later
migration that fails for reasons nobody connects to it.

Drizzle applies every pending migration inside **one** transaction. That is
what makes a half-applied migration impossible, and it also means
`CREATE INDEX CONCURRENTLY` — which cannot run in a transaction block — will
fail here. This is a property of the migrator rather than of this setup
(`drizzle-kit migrate` behaves the same), but it matters more now that
migrations gate every merge: an index on a table large enough to care about
locking needs applying by hand, outside the deploy.

`db/migrate.ts` uses `drizzle-orm`'s migrator rather than `drizzle-kit migrate`,
because drizzle-kit is a development tool that opens its own connection — there
is no way to give it `prepare: false` and `max: 1`. `npm run db:migrate` remains
the drizzle-kit path for local use.

## Portability

The only Vercel-specific dependency the application would have to _replace_
is image storage, and it sits behind a single module so it can be swapped in
one file. (`@vercel/analytics` is the one other vendor import in the tree, and
it is not an exception to this: on another host it is deleted rather than
reimplemented, so nothing is owed an interface.) Everything else runs on any
Node host with any Postgres:

- `output: "standalone"` produces a self-contained server bundle (it is switched
  off when `VERCEL` is set, since Vercel's builder emits its own output format
  and the standalone tracing step fails there)
- Environment variables are named generically (`DATABASE_URL`, not
  `SUPABASE_URL`; `STORAGE_TOKEN`, not `BLOB_READ_WRITE_TOKEN`)
- `prepare: false` is set unconditionally — required by Supabase's transaction
  pooler, harmless everywhere else
- The Supabase keep-alive cron belongs in GitHub Actions rather than Vercel
  Cron, since it is a Supabase concern and not an application one
- Migrations run through `npm run db:migrate:deploy`, an ordinary script with
  no host in it; only the line in `vercel.json` that calls it is Vercel-shaped,
  and another host would call the same script from its own build step

### The storage seam

That first bullet is the one that needs enforcing rather than asserting, and
`lib/storage.ts` (E5-T1) is the enforcement. It exports three functions —
`put`, `get`, `delete` — and it is the only file in the repository that
imports a storage vendor's SDK.

Both halves of that are checked. `lib/storage.test.ts` asserts the export list
is exactly those three names, and `lib/storage.call-sites.test.ts` scans the
source tree and fails if any other file names a `@vercel/*` package — the same
tripwire shape `lib/sanitize-html.call-sites.test.ts` uses, and for the same
reason. The claim above is not hard to keep true; it is hard to _notice_
becoming false, because `import { put } from "@vercel/blob"` in a route
handler works perfectly, reviews fine, and only costs anything on the day
somebody tries to leave.

The three functions are the intersection, not a subset chosen for now. Every
object store has `put`/`get`/`delete`; the moment a fourth appears — `list`,
`copy`, a presigned-URL helper — the set of hosts that can implement this
narrows to the ones that agree with Vercel, which is the seam leaking rather
than widening.

Five decisions inside the module are worth naming, because each is a default
that would have been wrong:

- **The credential is `STORAGE_TOKEN`**, read and passed explicitly. The SDK
  would happily pick up `BLOB_READ_WRITE_TOKEN` from the environment on its
  own, and leaning on that would put a vendor's variable name straight back
  into the deploy configuration this convention exists to keep generic. Same
  reasoning as `DATABASE_URL` over `SUPABASE_URL`.
- **The key you write is the key you read.** `addRandomSuffix` is pinned off;
  with it on, the stored path is something only the `put` response ever knew,
  and `get(key)` finds nothing.
- **`put` replaces.** Vercel's SDK defaults to refusing a write onto an
  existing path. S3, GCS, R2 and a filesystem do not. A seam whose semantics
  are one host's opinion is not a seam.
- **`get` returns a URL, not bytes.** Every host can produce one, and the
  alternative makes the application a proxy for its own static assets.
- **The store is private and the URL expires.** `access: "private"`, and both
  `put` and `get` return a signed URL rather than a permanent one. Why is
  [Images](#images) above; what it costs is the rest of this section.

#### Signed URLs, and what they cost

The seam paid for itself here, which is worth recording because that is the
kind of claim nobody usually gets to check. E5-T1 asserted that moving to
short-lived signed URLs "changes `put` and `get` in this one file and no call
site". `YEO-86` made the move: `lib/storage.ts` changed, its tests changed,
and the tripwire stayed green because the two new vendor calls
(`issueSignedToken`, `presignUrl`) landed inside the same file as the old
ones. The exported surface is still exactly `put` / `get` / `delete` — signing
is not a fourth function, which matters, because a `presign` export would have
narrowed the seam to hosts that agree with Vercel about how signing works.
S3, GCS and R2 all sign; a directory on disk can mint its own token. What they
do not agree on is the shape of the call, which is why it stays in here.

**Fifteen minutes**, chosen against what the URL has to survive rather than
against a round number. Its real job is the gap between rendering a page and
the browser fetching the image off it — seconds — and the rest is slack for a
slow connection, a tab left to load, or somebody opening the picture in its
own tab. A reload re-signs, so nothing user-visible depends on the window
being generous. What fifteen minutes deliberately does not outlast is the
leak, and every route in [Images](#images) is discovered later than that.

The delegation the signature is derived from is cached for an hour and reused.
Issuing one per URL would put a control-API round trip in front of every
image on a page, so a tree of thirty portraits would make thirty of them. It
is a cache lifetime and not a boundary: the signing key never leaves the
server, and what a browser receives is a URL already bound to one pathname and
one expiry.

##### The contract this sets for E5-T2 and after

> `key` is the durable handle. `url` is not — never persist it.

This is the "stable URL" question `YEO-42` had to answer, and the answer is
that the stable URL is not the storage host's. An entry body that embedded a
signed URL would render for fifteen minutes and show a broken image for the
rest of that revision's life, and revisions are append-only, so the broken
HTML would never be edited away. So:

- **The upload endpoint returns a key**, and the stable reference an author's
  HTML carries is a **site-relative path of this application's own**, resolved
  through `storage.get` per request. That is the same shape and the same
  reasoning as [Links between entries](#links-between-entries): bodies outlive
  the domain they were written on, and an absolute URL to somebody else's host
  ages badly and silently.
- **The sanitiser allowlist never needs to name a storage host.** Pinning
  `img[src]` to `*.blob.vercel-storage.com` would have written the vendor into
  the one file that is meant to be about markup, and undone the portability
  claim from a direction nothing was watching.
- **E5-T5's cleanup has something to match on.** "Referenced by no revision"
  is a query over keys. Against expiring URLs it would not be a well-formed
  question.

`E5-T2` shipped both halves of that, because either alone is incoherent.
`POST /api/images` stores an upload under a key it mints itself and answers
with the key and its site-relative path — never with the URL `put` handed
back, which would be a credential with a timer on it. `GET /api/images/…`
turns that path back into a freshly signed URL and redirects to it, behind the
same session guard as everything else, with `no-store` so that a cached
redirect cannot outlive its own target.

The redirect is deliberate: proxying the bytes would make this application a
CDN for its own images, holding a function open per photograph on a page. What
stays here is the authorisation; what never touches this code is the file.

The two halves also settle where the key check lives. `lib/storage.ts`
validates nothing on purpose and names the upload endpoint as the owner of
that obligation, and on the upload path the key is minted from a UUID and
cannot be steered — so the _resolving_ route is the caller that makes the
check load-bearing, and the two ship together for that reason as much as for
symmetry.

The credential itself belongs with `AUTH_SECRET` in the section above: it
grants write and delete on the store, and never appears in the repository.

## Known limitations

- **No RLS.** By design (see above), but it means a route handler that forgets
  `requireSession()` has nothing underneath it to fail safe.
- **People search reads the whole table.** `searchPeopleByName` selects every
  row of `individuals` and ranks it in TypeScript, because spelling tolerance
  is not a predicate a B-tree can answer (`lib/people-search.ts`). Since E8-T3
  that runs on a per-keystroke path rather than a per-page-load one; the 200ms
  debounce and a ceiling of a few hundred people are what keep it fine. A tree
  of thousands is what would change the answer, and the fix is named where the
  query lives: a generated `tsvector` over the name and a `WHERE` clause ahead
  of the ranking.
- **Uploads are capped at 4 MB.** Not a preference: a Vercel function
  receives at most a 4.5 MB request body, and the documented way past it is a
  browser talking to the storage vendor directly — which would put its SDK in
  a client bundle and need a fourth function on the seam, both of which this
  repository fails the build over. A recent phone routinely produces larger
  photographs than that, so the editor's image button (`E5-T3`) downscales in
  a canvas before it posts — `lib/image-insert.ts` decides when and to what,
  `components/image-upload.ts` does it. Two things survive as limitations
  rather than as bugs. **An animated GIF is never resized**, because a canvas
  keeps one frame, so an oversized one is refused with a sentence rather than
  silently turned into a still. And **a resize re-encodes as JPEG**, losing
  transparency to a white background — the only format every browser's
  `canvas.toBlob` is required to produce, and a trade only ever taken on a
  file that would otherwise not upload at all.
- **Orientation is respected, never repaired.** PNG, WebP and GIF keep
  whatever orientation tag they arrived with and nothing re-synthesises one,
  because nothing that produces those formats produces a rotated image.
- **Free-tier pausing.** Supabase pauses free projects after roughly a week of
  inactivity. A family wiki visited monthly will be found asleep. A daily cron
  that touches the database avoids this.
- **Photographs are outside the backup.** The nightly dump
  (`.github/workflows/backup.yml`, and [Backups](backups.md)) covers Postgres,
  which is where everything except the image files lives. Images sit in Blob
  storage behind `lib/storage.ts`, so a restore brings back a wiki that still
  knows which photograph belongs to whom and cannot show it, if the store went
  too. Rows are cheap to protect and files are not; this is the trade-off as
  it stands rather than an oversight.
- **Four GEDCOM date forms are stored slightly poorer than they were
  written.** An `INT` phrase — `INT 1890 (from baptism record)` becomes
  `about 1890` and the note survives only on the report. A modifier on a range
  endpoint — the `ABT` in `BET ABT 1890 AND 1900`, or in the one-sided
  `FROM ABT 1912`. A range whose upper bound
  is unreadable, stored as `after` its lower bound. And `EST 1918`, stored as
  `about 1918`, which is the oldest of the four and has been true since
  `lib/parse-date.ts` was written. All four are `narrowed` issues rather than
  accidents (`YEO-88`, `YEO-47`); the ranges themselves are stored whole.
- **An import can be previewed but not yet performed.** E6-T3 (`YEO-48`)
  landed the whole path up to and including consent — upload, parse, preview,
  cancel, and a confirming request that proves it is confirming the file that
  was previewed — and deliberately stopped there. Writing the rows is E6-T4
  (`YEO-49`), which lands them as one transaction that rolls back whole; a
  plain sequence of inserts added earlier to finish the button is the
  half-imported tree that ticket exists to prevent. Confirming today answers
  `501` and says so. See [Previewing an import](gedcom.md#previewing-an-import).
- **A previewed file is uploaded twice.** Once to be read and once to be
  imported, because a serverless function keeps nothing between requests and
  the alternative leaves every cancelled import as something to clean up
  later. The second upload carries the digest of the first.
- **Three things a GEDCOM file records have no column at all**: a second name
  for a person, a place for a marriage, and a first name that the file leaves
  blank. Each is reported per record rather than lost, and each is written up
  with its fix in
  [What GEDCOM has that this schema does not](#what-gedcom-has-that-this-schema-does-not).
