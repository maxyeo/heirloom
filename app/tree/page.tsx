import { FamilyTree } from "@/components/FamilyTree";
import { getFamilyGraph } from "@/lib/family-graph";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TreePage() {
  await requireSession();
  const graph = await getFamilyGraph();

  return (
    <main className="flex h-dvh flex-col">
      <header className="border-b border-stone-200 px-4 py-3 dark:border-stone-700">
        <h1 className="text-lg font-semibold">Family tree</h1>
        <p className="text-sm text-stone-500 dark:text-stone-400">
          {graph.people.length} people · {graph.unions.length} unions
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <FamilyTree graph={graph} />
      </div>
    </main>
  );
}
