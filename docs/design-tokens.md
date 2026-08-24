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
| `--color-rule`              | `#a2a9b1` | heading rules, panel borders                 |
| `--color-rule-soft`         | `#c8ccd1` | borders _inside_ a panel                     |
| `--color-link`              | `#3366cc` | unvisited                                    |
| `--color-link-visited`      | `#795cb2` | visited                                      |
| `--color-link-new`          | `#d33`    | a red link (E11-T6)                          |
| `--color-diff-added`        | `#eaf3ff` | a block a revision added                     |
| `--color-diff-added-rule`   | `#a3d3ff` | its left border                              |
| `--color-diff-removed`      | `#fef6e7` | a block a revision removed                   |
| `--color-diff-removed-rule` | `#ffe49c` | its left border                              |

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

## Deliberately not done

- **No dark mode.** Vector 2022 has one, but it is a second, separately tuned
  palette rather than an inversion of this one. Shipping a half-guessed one
  would be worse than shipping none, so `:root` declares `color-scheme: light`
  and the browser stops painting dark scrollbars over a light page.
- **No infobox styles.** Derived from the tree record, not authored — E11-T5.
- **No hatnote or table of contents.** E11-T3, T9.

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

## The rule that keeps this honest

**Nothing outside `app/globals.css` declares a colour.** A hex at a call site is
a value nobody will find again when the palette moves, and it is how a token
layer decays — quietly, one component at a time. `app/globals.test.ts` scans
`app/`, `components/` and `lib/` and fails on any hex it finds outside the
stylesheet.
