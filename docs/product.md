# Product

## What this is

A private wiki and family tree for one family. A few named people sign in;
everyone else gets a locked door. Entries are written in a normal
what-you-see-is-what-you-get editor, and the family tree is generated from
structured records rather than drawn by hand.

It is Wikipedia-shaped — linked entries about people and events, edited over
time, with history — but for a family, and readable only by that family.

## Who it is for

The primary author is **not a developer.** That single constraint drives most
of the product decisions below. Every feature has to survive the test of a
non-technical person sitting down on a Sunday afternoon with something they
want to record.

The secondary audience is whoever inherits this later, which is why history is
append-only and why data export matters more than it would for a weekend
project.

## Principles

**No Markdown.** A person who hits a bullet list that does not render will
stop using the site and not tell you why. The editor is WYSIWYG with a small
toolbar — bold, italic, heading, list, link, image. Nothing else.

**It looks like Wikipedia.** Not "inspired by" — the entries use Wikipedia's
visual language directly: the Vector 2022 skin, the serif headings with their
bottom rule, the sans-serif body, the blue links and the red ones, the pinned
table of contents, the infobox in the top right. The reason is recognition. A
non-technical author already knows how to read a Wikipedia article and already
knows what the blue link and the [edit] beside a heading will do. Borrowing a
familiar interface is cheaper than teaching a new one, and it sets the right
expectation about what an entry is for: a factual account, edited over time,
not a blog post.

Two deliberate departures, both downstream of the principles above:

- **The infobox is generated, never typed.** On Wikipedia an infobox is
  hand-written template markup. Here the facts already exist as records, so the
  box is derived from the tree and updates itself when the tree changes. The
  author never edits one.
- **There are no Talk pages.** Discussion apparatus belongs to a project with
  disputes to resolve between strangers. See Non-goals.

**Nobody positions anything.** The family tree lays itself out. There is no
dragging boxes, no arranging, no "save layout" button. Adding a person means
filling in a form and watching the tree redraw. This is also less code — see
`architecture.md`.

**Forms for editing, canvas for viewing.** The tree is for reading and
navigating. Changes happen in forms with labelled fields, because "Add a
spouse" is a comprehensible instruction and "drag a node onto another node" is
not.

**Nothing is ever destroyed.** Every save writes a revision. The recovery
story for "I accidentally deleted three paragraphs" is a one-click restore,
not a database backup.

**Sign-in is one click.** Google, not passwords, not magic links. The author is
already signed into Gmail in that browser; anything more is friction that
accumulates every single visit.

**The data belongs to the family.** GEDCOM export is a real goal, not a
nice-to-have. A family history trapped in someone's side project is a family
history with an expiry date.

## Status

**Working**

- Google sign-in restricted to an email allowlist
- Every route private by default
- Schema: individuals, unions, children, pages, revisions
- Seed fixture built from a genuinely awkward real family
- Read-only family tree with auto-layout, pan, zoom, and minimap

**Next**

- Wiki entries: view, edit (TipTap), revision history and restore
- Person↔page linking, so a node in the tree opens that person's entry
- Tree editing forms: add person, add spouse, add child, set parents
- Person detail panel on node click

**Later**

- Image uploads (behind a single storage module, so the host stays swappable)
- GEDCOM import — worth building the moment there is existing family data to
  bring in, because retyping several hundred people by hand is how a project
  like this dies
- GEDCOM export
- Search across entries
- "On this day" / recently changed, to give a reason to come back

## Non-goals

- **Public sharing.** Everything is behind auth. There is no anonymous view
  and no per-page visibility. If that changes, living-person privacy needs
  real thought first — genealogy convention suppresses details for the living.
- **Collaborative real-time editing.** Two people editing one page at the same
  moment is not a problem this project has.
- **Being Ancestry.** No record matching, no hints, no external genealogy
  database integration. This is a place to write down what the family already
  knows.
- **Mobile-first editing.** Reading on a phone should be pleasant. Writing a
  long entry is a desk activity.
