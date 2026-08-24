import { addSpouseAction, createIndividualAction } from "@/app/tree/actions";
import { AddPersonPanel } from "@/components/AddPersonPanel";
import { FamilyTree } from "@/components/FamilyTree";
import { getFamilyGraph } from "@/lib/family-graph";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TreePage() {
  await requireSession();
  const graph = await getFamilyGraph();

  return (
    <main className="flex h-dvh flex-col">
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
        <AddPersonPanel action={createIndividualAction} />
      </header>
      <div className="min-h-0 flex-1">
        {/*
          The add-spouse action (E3-T4) is handed down for the same reason, and
          one more: the canvas renders the form, so importing the action inside
          `FamilyTree` would take `components/FamilyTree.test.tsx` down with it.
        */}
        <FamilyTree
          graph={graph}
          addSpouseAction={addSpouseAction}
          /*
            And the add-person action once more (E3-T9): on an empty database
            the canvas is replaced by an invitation that opens the same panel
            the header does, so that the first screen of a fresh deployment
            has the thing it is asking for on it.
          */
          createIndividualAction={createIndividualAction}
        />
      </div>
    </main>
  );
}
