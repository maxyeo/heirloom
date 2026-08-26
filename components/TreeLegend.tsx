import type { TreeLegendEntry } from "@/lib/tree-legend";

/**
 * The key to the canvas's lines (E10-T5).
 *
 * Which rows a family earns is `lib/tree-legend.ts`'s decision and is
 * argued there; this file is the drawing. It renders nothing when handed
 * nothing, so a tree with no dashed line in it carries no furniture.
 *
 * ## Where it sits, and why that corner is free
 *
 * Top left, which is also where `TreeStartHint` sits — and the two can never
 * be on screen together. The hint is the `unconnected` stage, which is
 * `treeOnboarding`'s name for "no union joins anybody", and a key exists only
 * once a union has ended or a child arrived some way other than by birth.
 * Both of those need a union. The other three corners are taken: React Flow's
 * controls are bottom left, its minimap bottom right, and the detail panel
 * covers the right-hand edge at every width above `sm`.
 *
 * `pointer-events-none` for the reason the hint has it: this is a caption on
 * a surface whose whole interaction is dragging, and a box that swallowed a
 * drag would make the canvas feel broken in one corner.
 */
export function TreeLegend({
  entries,
}: {
  entries: readonly TreeLegendEntry[];
}) {
  if (entries.length === 0) return null;

  return (
    <aside
      aria-label="What the lines mean"
      className="pointer-events-none absolute top-3 left-3 z-10 max-w-xs rounded-panel border border-rule bg-panel px-3 py-2 shadow-sm"
    >
      <p className="text-note font-medium">What the lines mean</p>
      {/* `role="list"` for the reason `RecentChangesList` gives: Tailwind's
          preflight strips the markers, and stripping them also drops the
          list's semantics in Safari and VoiceOver. */}
      <ul role="list" className="mt-1 space-y-1">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-2 text-note text-ink-muted"
          >
            {/*
              The sample, drawn from the same `strokeDasharray` the canvas
              draws the real line with — see `TreeLegendEntry.dash`.

              `currentColor` rather than React Flow's own edge grey, and the
              difference is deliberate rather than an approximation. Restating
              that grey here would mean a hex outside `app/globals.css`, which
              `app/globals.test.ts` refuses on principle; but the better reason
              is that this ticket's criterion is that colour carries no
              meaning, and a key whose samples are matched by *hue* to the
              lines they explain quietly says the opposite. Inheriting the
              row's ink also puts the sample at 6.7:1 on this panel where the
              canvas's grey would be nearer 2:1 — a line is a graphical object,
              and 3:1 is what WCAG asks of one.
            */}
            <svg
              aria-hidden="true"
              width="28"
              height="8"
              viewBox="0 0 28 8"
              className="shrink-0"
            >
              <line
                x1="0"
                y1="4"
                x2="28"
                y2="4"
                stroke="currentColor"
                strokeWidth="1.5"
                {...(entry.dash === null
                  ? {}
                  : { strokeDasharray: entry.dash })}
              />
            </svg>
            <span>{entry.label}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
