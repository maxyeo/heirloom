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
      <header className="px-4 py-3">
        <h1>Family tree</h1>
        <p className="text-caption text-ink-muted">
          {graph.people.length} people · {graph.unions.length} unions
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <FamilyTree graph={graph} />
      </div>
    </main>
  );
}
