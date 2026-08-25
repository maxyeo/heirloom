import type { Metadata } from "next";

import { type ExportOption, exportOptions } from "@/lib/export-options";
import { requireSession } from "@/lib/session";

/**
 * Settings — which today is the place the family takes its data with it
 * (E7-T3, `YEO-53`).
 *
 * The ticket calls it "somewhere to click", and that is the honest scope: the
 * export already worked before this page existed (E7-T1, `YEO-51`), it simply
 * had no door. What this page owns is the two things that are not the file —
 * the session guard, and saying what the file *is* before somebody saves it
 * somewhere and stops thinking about it.
 *
 * ## Why the offers are read from a list
 *
 * `lib/export-options.ts`, and the reasoning is there. The short of it: E7-T4
 * (`YEO-54`) adds a second download beside this one, and it should be able to
 * do that by editing a list rather than this component. It did — the whole of
 * that ticket's change to this screen was three fields in that file, and this
 * component was not reopened.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  return (
    // The same column as the import screen: `max-w-content` is Vector 2022's
    // 46em measure, and the padding is the mobile half of it.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/* Serif, and carrying its own bottom rule, from globals.css. */}
      <h1>Settings</h1>

      <h2>Download your data</h2>

      <div className="wiki-body">
        <p>
          Everything on this site can be taken out of it at any time, in formats
          other programs read. Nothing is deleted by downloading it, and you can
          do it as often as you like.
        </p>
      </div>

      {/* Preflight strips list markers outside `.wiki-body`, which is what is
          wanted here: these are cards, not a bulleted list. */}
      <ul className="mt-4 flex flex-col gap-4">
        {exportOptions.map((option) => (
          <li key={option.id}>
            <ExportCard option={option} />
          </li>
        ))}
      </ul>
    </main>
  );
}

/** One thing you can download, or one thing you will be able to download. */
function ExportCard({ option }: { option: ExportOption }) {
  return (
    <section className="rounded-panel border border-rule-soft bg-panel p-4">
      {/* Sans and bold, below the ruled levels — the page's h1 and the section
          h2 above already carry the hierarchy. */}
      <h3>{option.title}</h3>
      <p className="mt-1 text-caption text-ink-muted">{option.summary}</p>

      {/*
        Before the button rather than after it. The ticket's point is that the
        caveat has to reach somebody *at the point of download* — a note under
        a button they have already pressed is documentation with extra steps.
      */}
      {option.caveat ? (
        <div className="mt-3 rounded-panel border border-rule-soft bg-paper px-3 py-2 text-caption">
          <p>{option.caveat.lead}</p>
          <p className="mt-2">It does not contain:</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">
            {option.caveat.missing.map((thing) => (
              <li key={thing}>{thing}</li>
            ))}
          </ul>
          <p className="mt-2">{option.caveat.pointer}</p>
        </div>
      ) : null}

      <p className="mt-3">
        {option.href === null ? (
          /*
            Inert text rather than a button that 404s — `lib/site-nav.ts`'s
            rule for a destination that does not exist yet, and this is the
            other place it applies.
          */
          <span className="text-note text-ink-muted">
            {option.action} — not yet. {option.pendingTicket} builds it.
          </span>
        ) : (
          /*
            A plain `<a>`, not `next/link`. The destination is a route handler
            answering with `Content-Disposition: attachment`, so there is no
            page to prefetch and nothing for the client router to navigate to —
            the browser saves the response and leaves the page where it is.
            No `download` attribute either: the filename is the server's,
            because that is where the date comes from
            (`lib/export-endpoint.ts`), and a `download` value here would
            override the header with something this component would then have
            to keep in step.
          */
          <a
            href={option.href}
            className="inline-block rounded-panel border border-rule bg-wash px-3 py-1 text-note font-medium hover:bg-paper"
          >
            {option.action}
          </a>
        )}
      </p>
    </section>
  );
}
