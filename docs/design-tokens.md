# Design tokens

Heirloom looks like Wikipedia. Not approximately — the same type, the same
blue, the same rules under the same headings. The reasoning is in
[product.md](product.md): the author already knows how to read a Wikipedia page,
and borrowing a familiar interface is cheaper than teaching a new one.

This is the reference for the values that make that true. They live in one
place, `app/globals.css`, and they are the whole styling API.

## Where the configuration is

Tailwind 4 is configured **in CSS**. There is no `tailwind.config.js` and there
should not be one — `@theme` in `app/globals.css` is the config, and each
namespace generates its own utilities:

| Namespace       | Generates                                            |
| --------------- | ---------------------------------------------------- |
| `--color-*`     | `text-ink`, `bg-panel`, `border-rule`, …             |
| `--text-*`      | `text-body` — font size **and** its leading together |
| `--container-*` | `max-w-content`, `w-thumb`                           |
| `--radius-*`    | `rounded-panel`                                      |

## The tokens

### Type

Serif headings over a sans body is the single most recognisable thing about a
Wikipedia page.

| Token                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| `--font-serif`            | `"Linux Libertine", Georgia, Times, serif`           |
| `--font-sans`             | the system sans stack                                |
| `--text-body`             | `0.875rem` / `1.6` — the content column              |
| `--text-caption`          | `0.8rem` / `1.5` — captions, taglines, infobox rows  |
| `--text-note`             | `0.75rem` / `1.5` — `[edit]` links, footer furniture |
| `--text-h1` … `--text-h4` | `1.8rem`, `1.35rem`, `1rem`, `0.875rem`              |

**On the heading face.** Linux Libertine is Wikipedia's actual heading font and
is SIL Open Font Licensed, but self-hosting it means a webfont request on every
page view. It stays first in the stack so anyone who has it installed gets it,
and Georgia — Wikipedia's own declared fallback, and web-safe — does the work
for everyone else. Nobody who is not comparing side by side will see the
difference. Revisit if that turns out to be wrong.

**On 14px.** It is smaller than a modern default on purpose. It is what makes a
dense article read as an encyclopedia entry rather than a blog post.

### Colour

| Token                       | Value     | Used for                                     |
| --------------------------- | --------- | -------------------------------------------- |
| `--color-paper`             | `#ffffff` | the article surface                          |
| `--color-panel`             | `#f8f9fa` | infoboxes, tables, code — the filled surface |
| `--color-wash`              | `#eaecf0` | table headers, hairlines                     |
| `--color-ink`               | `#202122` | body text                                    |
| `--color-ink-muted`         | `#54595d` | captions, secondary text                     |
| `--color-rule`              | `#72777d` | structural: bounds a control or a region     |
| `--color-rule-soft`         | `#c8ccd1` | decorative hairline — exempt under 1.4.11    |
| `--color-link`              | `#3366cc` | unvisited                                    |
| `--color-link-visited`      | `#6a60b0` | visited                                      |
| `--color-link-new`          | `#bf3c2c` | a red link (E11-T6)                          |
| `--color-diff-added`        | `#eaf3ff` | a block a revision added                     |
| `--color-diff-added-rule`   | `#a3d3ff` | its left border                              |
| `--color-diff-removed`      | `#fef6e7` | a block a revision removed                   |
| `--color-diff-removed-rule` | `#ffe49c` | its left border                              |

**On the contrast floor.** Every colour in this table that text is set in
clears **4.5:1** — WCAG 2.2 AA below 18pt — against every surface it can be
painted on, and `app/globals.test.ts` computes the ratios out of `globals.css`
rather than trusting this paragraph. `--color-wash` is the binding surface: it
is the darkest of them, and links land on it more often than you would guess —
a `th` in a wikitable, the highlighted row in the search suggestions, the
header block on the compare view.

Two of the three link colours moved for that in E10-T5 (`YEO-69`), and neither
is a redesign. Visited was Vector 2022's `#795cb2`, which is 4.45:1 on
`--color-wash` — a miss of about one percent, and exactly the kind that is
never found by looking. A red link was `#d33`, which is 4.33:1 on
`--color-panel`, where the person infobox puts a column of them. Both are now
Wikimedia's own accessible values, and all three links land at ~4.55:1 on the
darkest surface. `--color-link` did not move.

**On the non-text floor.** Borders have their own threshold and their own
suite. WCAG 2.2 SC 1.4.11 asks **3:1** — not 4.5:1 — of the visual information
needed to identify a user interface component and its state, and of a graphical
object needed to understand the content. It asks nothing of decoration, and it
exempts an appearance the browser determines, so a native control this
stylesheet has not restyled is already compliant and repainting it would only
make it ours to get wrong.

`YEO-107` is where that was answered, and the answer is **two tokens with two
contracts** rather than one border colour pushed down until its worst case
passes:

| Token               | Owes | What it draws                                                                                                                                                             |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-rule`      | 3:1  | a button, a field, a menu, a panel, a table cell, a card on the tree canvas, the rule under an `h1` or `h2`, a tree edge, the seam under a slide-up panel's pinned header |
| `--color-rule-soft` | —    | one row of a list or of the infobox from the next, the frame of a thumbnail, the line the article tabs attach to                                                          |

The test to apply at a call site is not "is this a border" but **"if this line
were not drawn, would something stop being identifiable?"**. A field with no
border is a piece of paper. A list with no row rules is still a list. A
slide-up panel whose pinned header shares a fill with the body scrolling under
it has nothing else to say where the one stops and the other starts. The split
is argued once at the tokens so that no component has to re-decide it, and the
rule of thumb that falls out of those three is that a hairline between two
things of the **same kind** is decorative and a hairline between two things
that **behave differently** is not.

`--color-rule` was Vector 2022's `#a2a9b1`, which is 2.37:1 on paper — and the
audience skews older, which is what makes a 2.37:1 line between one table row
and its neighbour the difference between a table and a grey wash. `#72777d` is
the next step down WikimediaUI's own grey ramp, and what Codex ships as
`border-color-interactive`: Wikimedia's answer to "a border that has to be
seen". It is 4.52:1 on paper and 3.82:1 on `--color-wash`, the darkest surface,
so it clears the floor with room rather than by a rounding error.

`--color-rule-soft` did not move. It is **named as exempt with its reason** in
`app/globals.test.ts` rather than left as a token the guard happens not to ask
about, and so are the two diff gutter rules.

**On arguing an exemption from the right criterion.** `YEO-118` rewrote the
diff gutter's reason, which had been a 1.4.1 one: _the compare view names every
changed block in words, so colour is not the only carrier._ That is a true
sentence and it answers the wrong question. 1.4.1 asks whether colour alone
carries a meaning; 1.4.11 asks whether a **visual boundary** is needed to
identify something. They come apart — a form field's border is the only thing
that makes the field findable even though a visible label names it — so an
exemption argued from the first has not been argued at all.

Run 1.4.11's question on the gutter instead. A diff row is not a user interface
component: nothing in it is operated and it holds no state, so only the
graphical-object half of the criterion reaches it, and that half asks whether
this part of the drawing is needed to understand it. Take the 4px rule away and
the row is still filled and still marked `+` or `−` in the gutter the rule sat
in; added against removed is two fills, and changed against moved is solid
against dashed with the moved rows drawn in `--color-rule` above the floor. The
coloured rule is the saturated edge of its own fill rather than the line that
bounds the row — 1.41:1 against the blue it edges, 1.16:1 against the yellow —
so it thickens a boundary the fill has already made instead of being one. Same
conclusion, reached honestly.

The five slide-up panel headers went the other way. `components/PersonPanel.tsx`,
`AddPersonPanel.tsx`, `AddChildForm.tsx`, `AddSpouseForm.tsx` and
`SetParentsForm.tsx` each drew the seam between the header and the scrolling
body in `--color-rule-soft`, on the reading that the heading and the Close
button identify the header by themselves. That borrows the list-row argument,
and a panel header is not a list row: the `aside` carries `bg-panel` and the
`overflow-y-auto` body declares no fill of its own, so once the body has
scrolled, the line is the only thing left saying which half is pinned — and at
1.53:1 it was not saying it. All five are `--color-rule` now, which is the
colour the panel's own frame was already drawn in, so each panel has one border
weight instead of two. `app/globals.test.ts` holds it, because five identical
blocks of Tailwind are one careless copy away from drifting back.

**A surface token is never a border.** `--color-paper`, `--color-panel` and
`--color-wash` are within about 1.2:1 of each other by design, because they are
backgrounds for text. `--color-wash` was drawing the seam under the sticky
header and down the sidebar's edge at 1.18:1 — a line that existed in the
stylesheet and not on the screen. Both are `--color-rule` now, and
`app/globals.test.ts` fails on any `border-`, `divide-`, `outline-` or `ring-`
utility built from a fill.

**Focus indicators** are `--color-link` everywhere — the base `:focus-visible`
outline and the tree node ring E10-T5 restored — which is 5.37:1 on paper and
4.54:1 on the darkest surface, so they clear the non-text floor by the same
margin the text floor gives them.

**On the diff pair.** Blue and yellow, not green and red. That is
MediaWiki's choice and the reason for it is worth keeping: red and green
are the pair the most common colour blindness collapses. The compare view
does not lean on colour alone anyway — every changed block is labelled in
words and marked in the gutter — but the default should still be legible
to everyone who reads it at a glance.

### Layout

| Token                 | Value                                         |
| --------------------- | --------------------------------------------- |
| `--container-content` | `46em` — Vector 2022's measure                |
| `--container-thumb`   | `220px` — Wikipedia's default thumbnail width |
| `--container-infobox` | `20.5rem` — the person infobox (E11-T5)       |
| `--radius-panel`      | `2px` — Vector 2022 rounds almost nothing     |

The measure is in `em` deliberately, so it scales with the content type rather
than drifting away from it. At the 14px body size it resolves to ~644px, which
is the Wikipedia column. Apply it as `max-w-content` on the element holding the
prose — `app/page.tsx` is the current example. The E11-T2 shell sets that
column beside the sidebar but does not own it; see "The shell" below.

## Base styles, and the one distinction that matters

Element defaults are global, in `@layer base`. The important one:

> **`h1` and `h2` carry the bottom rule. `h3` and below do not.**

That is what makes a page's section hierarchy readable at a glance, so it is a
property of the elements rather than of a class someone has to remember to
apply. `h3` and below also switch from serif to bold sans, which is the second
half of the same signal.

Links follow from the same instinct: colour, no underline until hover. A page of
underlined blue is unreadable, and the colour is signal enough once every link
on the page has it.

## `.hatnote`

The indented italic line above the lead paragraph — MediaWiki's class name and
MediaWiki's three declarations (`font-style: italic`, a `1.6em`
`padding-inline-start`, a `0.5em` bottom margin), borrowed for the same reason
the rest of the skin is: a reader who has met a hatnote on Wikipedia already
knows the line is not the article and is there to send them elsewhere.

It sits **outside** `.wiki-body`, deliberately. A hatnote is not article prose:
it is stored in `pages.hatnote` rather than in the body, rendered above it, and
never reaches the article's own stylesheet as content. The one place the two
classes appear together is the edit form's hatnote field, where `wiki-body
hatnote` on the writing surface is what makes the field look like the line it
becomes.

Two hatnotes can stack — the author's and the automatic "For other people named
…" one. The margin is on the bottom rather than the top so that stacking spaces
them evenly and leaves exactly one gap above the first paragraph. An entry with
neither renders **no element at all**, which is asserted in
`components/ArticleHatnote.test.tsx` rather than left to the eye.

## `.wiki-body`

The article body — the equivalent of MediaWiki's `.mw-parser-output`. It carries
the styles for lists, definition lists, blockquotes, tables and framed
thumbnails.

Those are **scoped** rather than global because Tailwind's preflight strips list
markers on purpose, and the wiki chrome — navigation, table of contents, tabs —
wants them to stay stripped. Restoring markers globally would mean turning them
off again everywhere else.

The same class serves the read route and the editor canvas. That is the point:
what you type is what the article looks like.

Two things inside it take a modifier:

- `figure` is the framed thumbnail. It floats right, the way `[[File:…|thumb]]`
  does. `figure.thumb-left` is the other side. Below 40rem both go full width,
  because a 220px float in a phone-width column leaves a two-word measure
  beside it.
- `a.new` is a red link, and stays red after it has been followed.
- `h2`, `h3` and `h4` carry a `scroll-margin-top` of
  `calc(var(--header-height) + 0.5rem)`. The header is sticky, so an anchor
  scrolled to `top: 0` arrives underneath it; this is the browser's own answer,
  and it applies to `#fragment` links, `scrollIntoView` and the back button
  alike. See "The contents panel" below.

## Deliberately not done

- **No dark mode.** Vector 2022 has one, but it is a second, separately tuned
  palette rather than an inversion of this one. Shipping a half-guessed one
  would be worse than shipping none, so `:root` declares `color-scheme: light`
  and the browser stops painting dark scrollbars over a light page.
- **No hand-written infobox.** E11-T5 built the box, and it added one token
  (`--container-infobox`) and no rules: `components/PersonInfobox.tsx` is
  `bg-panel` inside `border-rule` with `border-rule-soft` between the rows,
  which is Vector 2022's infobox and was already declared above. What stays
  deliberately absent is the _markup_ — there is no infobox template for an
  author to type, because every row is derived from `individuals` / `unions` /
  `union_children` at render time. See `lib/person-infobox.ts`.
- **No hatnote.** E11-T9.

## The shell

E11-T2 added the page furniture around an article — sticky header, collapsible
left sidebar, and the region the content column sits in. It is assembled in
`components/AppShell.tsx` entirely out of the tokens above; there is not a
colour or a type size in it that this file did not already declare.

Three things about it are not utilities, and so live in `app/globals.css`:

| Name              | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `--header-height` | `3rem` — the sticky header, and so where the usable viewport starts |
| `.site-sidebar`   | the sidebar: a pinned column, a drawer, or nothing                  |
| `.site-scrim`     | the dim behind the drawer                                           |

Both classes exist because their answer depends on `data-sidebar` on `<html>`,
which is an **ancestor** attribute, and utilities style the element they are on.
`--header-height` is a plain custom property rather than a `@theme` token
because it generates no utility of its own: it is read as `h-(--header-height)`
on the header and inside `calc()` by anything that has to fill what is left
below it — `app/tree/page.tsx` is the worked example.

**The shell does not own the content column.** Every route still centres its own
`<main>` at `max-w-content`; the shell only gives that column somewhere to be,
beside the sidebar. That is what lets `/tree` be a full-bleed canvas and
`/wiki/[slug]` be a 46em measure inside the same chrome, with neither of them
fighting a wrapper.

**Where the state lives.** `data-sidebar` on `<html>`, set by an inline script
before the first paint, because a sidebar the viewer collapsed cannot be allowed
to appear for a frame on every page load. `lib/sidebar-preference.ts` has the
long version, including why the stored preference is a wide-screen one that a
phone ignores.

## The stacking order

Three `z-index` bands belong to the shell rather than to any one component, and
they are enumerated here so that no component has to restate them:

| Band | What is in it                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 50   | `.skip-link`, `ModalDialog`'s backdrop, `SearchBox`'s suggestions, `AccountMenu`'s menu                               |
| 40   | the sticky header (`components/SiteHeader.tsx`), and the sidebar while it is a drawer (`.site-sidebar` below `55rem`) |
| 30   | `.site-scrim`, the dim behind that drawer                                                                             |

Everything else this application numbers — the tree's legend, its onboarding
note, its detail and slide-up panels, the article tabs' collapsed menu — is
local to the canvas or the positioned box that draws it, and none of it is
above 20. Those numbers are deliberately **not** listed: a table nobody checks
is a table that drifts, and the three bands above are the ones
`app/globals.test.ts` holds.

**The top band is a tie, and the tie is not in the skip link's favour.** At an
equal `z-index` the painting order is document order, and `SkipLink` is the
first element in `components/AppShell.tsx` — ahead of all three of its peers,
none of which portals. So the link loses every one of those ties, and 50 is not
by itself what keeps it visible.

What keeps it visible lives in the peers. `ModalDialog` confines Tab to its own
surface, so the backdrop — the only one of the three that covers the viewport —
cannot paint over a link that cannot be focused while it is open. The search
suggestions and the account menu are anchored to the controls that open them,
below and to the right of the top-left corner the link occupies.

That is an argument spread across four files, which is why it is asserted
rather than only written down: `app/globals.test.ts` names the three peers,
checks that `ModalDialog` is the only full-bleed one and that it still traps
Tab, and holds 50 as the ceiling. A fourth overlay in this band fails a test
instead of leaving a paragraph quietly wrong. `YEO-114` is where that was
found; the long version of the reasoning is in `app/globals.css` beside
`.skip-link`.

**Do not break the tie by raising the link.** The band is deliberate — three
unrelated overlays chose it independently — and a `z-51` skip link trades a
documented tie for an undocumented race. The thing to check when adding an
overlay is not its number but whether it can cover the top-left corner while
the skip link is still reachable.

## The article tabs

E11-T7 hung the Article / Read / Edit / View history row on the seam the shell
left for it, above the content column. It adds **no token and no rule to this
file** — Vector 2022's tab treatment turns out to be four values that were all
already here:

| Part                 | Expressed as                                        |
| -------------------- | --------------------------------------------------- |
| the row's hairline   | `border-rule-soft`                                  |
| an unselected tab    | `text-link`, over a transparent 2px bottom border   |
| the selected tab     | `text-ink`, over a 2px `border-link` bottom border  |
| the tab's attachment | `-mb-px`, so that 2px border sits _on_ the hairline |

That last one is the whole trick. Without it the tab has a line under it; with
it the tab is attached to the page below, which is what makes a tab a tab.

Three things about the row are worth knowing before changing it:

- **It opts into the content column by hand** — `mx-auto max-w-content` and the
  same horizontal padding every route gives its own `<main>`. The shell does not
  own that column (above), so anything sitting above the route's content has to
  line itself up with it.
- **It is a function of the path.** `lib/article-tabs.ts` decides which tab is
  current and whether there is an article here at all;
  `components/ArticleTabs.tsx` only renders the answer, and
  `components/RoutedArticleTabs.tsx` is the client boundary that reads
  `usePathname`. On `/tree`, `/wiki` and `/wiki/new` the row renders nothing.
- **Below `sm` the view tabs collapse** into a `<details>` labelled with the
  view you are on. The namespace tab stays visible; it is one word, and it is
  the anchor the menu would otherwise hide.

**No Talk tab**, and that is a decision rather than an omission — see the header
of `lib/article-tabs.ts`. It is also why "Article" is a label rather than a
link: with one namespace there is nowhere for it to go that "Read", beside it,
does not already go.

## The contents panel

E11-T3 added Vector 2022's "Contents" under the sidebar's "Navigation". It is
generated from the entry's `bodyHtml` on every render and stored nowhere —
`lib/article-outline.ts` derives a stable id for each `h2`/`h3`/`h4` from the
heading's own text, numbering a repeat `-2`, `-3`, and so on. A stored id would
survive the author renaming the heading and quietly point at the wrong section.
E11-T4's section `[edit]` links share that function rather than slugging again.

It brings no colour and no type size of its own: the panel is `text-note` on
`--color-ink-muted`, the current section is `--color-ink` with a
`--color-rule` bar beside it, and both are utilities.

The one number it needs is `--header-height`, and it does not read it directly.
The stylesheet gives article headings a `scroll-margin-top` derived from the
token; the browser uses that when it scrolls to an anchor, and
`components/ArticleContents.tsx` reads the same resolved value back off the
heading to decide which section is current. One declaration, three uses — which
is what keeps "the highlighted section" and "the section a click lands on" from
drifting apart.

## The tree canvas's borrowed stylesheet

`components/FamilyTree.tsx` imports `@xyflow/react/dist/style.css` as a plain
stylesheet, so its rules are **unlayered** — and an unlayered declaration beats
a layered one before specificity is consulted at all. That is why the two
things `app/globals.css` says about the canvas are the only two rules in the
file outside every layer:

| Rule                                           | What it is for                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `.react-flow .react-flow__node…:focus-visible` | putting back the focus outline React Flow's own `outline: none` takes away (E10-T5) |
| `.react-flow { --xy-… }`                       | three React Flow variables repointed at `--color-rule` (`YEO-107`)                  |

The variables are `--xy-edge-stroke`, `--xy-controls-button-border-color` and
`--xy-minimap-node-background-color`. React Flow's defaults for them are
`#b1b1b7`, `#eee` and `#e2e2e2` — 2.13:1, 1.16:1 and 1.30:1 on the paper the
canvas sits on.

**The edges are the reason this is done in CSS at all.** An edge is the whole
of what says who is married to whom, so it is a graphical object under 1.4.11
rather than decoration. But `lib/tree-layout.ts` states — and
`lib/tree-layout.test.ts` enforces — that no edge declares a colour, because
the qualification on a relationship rides entirely on `strokeDasharray` and an
edge that _could_ carry a colour is an edge somebody later tints red, handing
the one channel a colour-blind reader has to the one they do not. One
declaration in the stylesheet covers every edge in both dash states and leaves
that rule intact.

Two things on the canvas are **deliberately left alone and named as exempt**:
the `<Background />` dot grid, which is texture that says the surface can be
panned and carries nothing about the family, and the minimap's dimmed mask,
which is not a boundary anything is identified by — the minimap duplicates a
canvas that is fully present beside it, and every operation it offers is on
`<Controls />` and the keyboard too. Its _nodes_ are the drawing rather than
the frame, so those do take `--color-rule`.

## The rule that keeps this honest

**Nothing outside `app/globals.css` declares a colour.** A hex at a call site is
a value nobody will find again when the palette moves, and it is how a token
layer decays — quietly, one component at a time. `app/globals.test.ts` scans
`app/`, `components/` and `lib/` and fails on any hex it finds outside the
stylesheet.
