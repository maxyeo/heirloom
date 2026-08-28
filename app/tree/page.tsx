import Link from "next/link";

import {
  addChildAction,
  addSpouseAction,
  createEntryForPersonAction,
  createIndividualAction,
  linkPersonEntryAction,
  reorderUnionsAction,
  setParentsAction,
  unlinkPersonEntryAction,
  updateIndividualAction,
  updateUnionAction,
} from "@/app/tree/actions";
import { AddPersonPanel } from "@/components/AddPersonPanel";
import { DeepLinkedFamilyTree } from "@/components/DeepLinkedFamilyTree";
import { getFamilyGraph } from "@/lib/family-graph";
import { listEntryLinks } from "@/lib/pages";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TreePage() {
  await requireSession();

  /**
   * Two independent reads, so they overlap rather than queue. The entries are
   * for E2-T2's link on the detail panel: which one a person already has, and
   * which are still free to be linked to somebody. See `lib/entry-link.ts` for
   * why they travel as their own list rather than as columns on the graph.
   */
  const [graph, entries] = await Promise.all([
    getFamilyGraph(),
    listEntryLinks(),
  ]);

  return (
    // The viewport less the shell's sticky header (E11-T2). It was `h-dvh`
    // before there was a header above it; left that way the canvas would run
    // 3rem past the bottom of the screen and give the page a scrollbar with
    // nothing in it.
    <main className="flex h-[calc(100dvh-var(--header-height))] flex-col">
      {/* The h1 carries its own rule (globals.css), so the header needs no
          border of its own. */}
      {/*
        The button sits beside the title rather than flush against the right
        edge, because the right edge is no longer the page's to give: the
        person panel is `fixed` from the site header down (see
        `components/PersonPanel.tsx`), and a `justify-between` header put
        "Add person" under it the moment anybody clicked a node. Grouped left
        it collides with nothing, at any width, selected or not — which beats
        reserving `w-80` of permanent empty paper for a panel that is usually
        closed.
      */}
      <header className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0">
          <h1>Family tree</h1>
          <p className="text-caption text-ink-muted">
            {graph.people.length} people · {graph.unions.length} unions
          </p>
          {/*
            The way in to E6-T3's import screen, and the only one — the
            sidebar's five links are `lib/site-nav.ts`'s own set (four off the
            E11 reference mockup, plus "New entry"), and giving import a sixth
            is a decision about the shell rather than about importing. Here is
            where it belongs anyway: this is the page an import changes, and
            the counts above are what it changes them from.
          */}
          <p className="text-note">
            <Link href="/import">Import a GEDCOM file</Link>
          </p>
        </div>
        {/*
          The action is handed to the panel rather than imported by it: a
          Client Component that imports a `"use server"` module pulls the
          database and the session layer in behind it. See the note in
          `AddPersonPanel`.
        */}
        {/*
          Hidden while there is nobody on the tree (E3-T9): the empty state
          below opens this very panel under a label that suits a first run, and
          two buttons for one flow is two independent `open` states landing two
          identical, non-modal panels in the same fixed corner. The first
          screen of a deployment should ask for exactly one thing.
        */}
        {graph.people.length === 0 ? null : (
          <AddPersonPanel action={createIndividualAction} />
        )}
      </header>
      <div className="min-h-0 flex-1">
        {/*
          The add-spouse action (E3-T4) and the edit-person action (E3-T3)
          are handed down for the same reason, and one more: the canvas renders
          both forms, so importing either action inside `FamilyTree` would take
          `components/FamilyTree.test.tsx` down with it.
        */}
        {/*
          The canvas, wrapped in the ten lines that read and write
          `?person=<id>` (E2-T4). The wrapper is a Client Component because
          `useSearchParams` is a client hook and this page is not; the canvas
          itself stays unaware of routing, which is what keeps it mountable in
          a test with no router. See `components/DeepLinkedFamilyTree.tsx`.
        */}
        <DeepLinkedFamilyTree
          graph={graph}
          addSpouseAction={addSpouseAction}
          addChildAction={addChildAction}
          updateIndividualAction={updateIndividualAction}
          /*
            And the set-parents action (E3-T6), for the flow that connects
            somebody who was added on their own to the family they belong to.
          */
          setParentsAction={setParentsAction}
          /*
            And the add-person action once more (E3-T9): on an empty database
            the canvas is replaced by an invitation that opens the same panel
            the header does, so that the first screen of a fresh deployment
            has the thing it is asking for on it.
          */
          createIndividualAction={createIndividualAction}
          /*
            And the union reorder action (E3-T7), which the detail panel's
            footer needs: `unions.sequence` is the one column the tree has
            always sorted on and nothing has ever written.
          */
          reorderUnionsAction={reorderUnionsAction}
          /*
            And the edit-union action, for the correction dialogue the panel's
            spouse rows open: the dates on a marriage were writable from the
            first day the add-spouse form existed and were not changeable
            until this one, so a mistyped year could only be repaired by
            deleting the union and every child link hanging off it.
          */
          updateUnionAction={updateUnionAction}
          /*
            And the entry link (E2-T2): the entries themselves, plus the three
            actions that set and clear `individuals.page_id`. One prop for the
            three, because they are one feature — see `PersonEntryActions`.
          */
          entries={entries}
          entryActions={{
            create: createEntryForPersonAction,
            link: linkPersonEntryAction,
            unlink: unlinkPersonEntryAction,
          }}
        />
      </div>
    </main>
  );
}
