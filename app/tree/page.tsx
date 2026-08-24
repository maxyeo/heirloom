import {
  addChildAction,
  addSpouseAction,
  createIndividualAction,
  reorderUnionsAction,
  setParentsAction,
  updateIndividualAction,
} from "@/app/tree/actions";
import { AddPersonPanel } from "@/components/AddPersonPanel";
import { FamilyTree } from "@/components/FamilyTree";
import { getFamilyGraph } from "@/lib/family-graph";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TreePage() {
  await requireSession();
  const graph = await getFamilyGraph();

  return (
    // The viewport less the shell's sticky header (E11-T2). It was `h-dvh`
    // before there was a header above it; left that way the canvas would run
    // 3rem past the bottom of the screen and give the page a scrollbar with
    // nothing in it.
    <main className="flex h-[calc(100dvh-var(--header-height))] flex-col">
      {/* The h1 carries its own rule (globals.css), so the header needs no
          border of its own. */}
      <header className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h1>Family tree</h1>
          <p className="text-caption text-ink-muted">
            {graph.people.length} people · {graph.unions.length} unions
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
        <FamilyTree
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
        />
      </div>
    </main>
  );
}
