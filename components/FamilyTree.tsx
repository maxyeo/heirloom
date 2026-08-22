"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useMemo } from "react";

import "@xyflow/react/dist/style.css";

import type { FamilyGraph } from "@/lib/family-graph";
import { layoutFamilyGraph } from "@/lib/tree-layout";

function PersonNode({ data }: NodeProps<Node<Record<string, unknown>>>) {
  const name = String(data.name ?? "");
  const lifespan = String(data.lifespan ?? "");

  return (
    <div className="w-44 rounded-md border border-stone-300 bg-white px-3 py-2 shadow-sm dark:border-stone-600 dark:bg-stone-800">
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
        {name}
      </div>
      {lifespan ? (
        <div className="text-xs text-stone-500 dark:text-stone-400">
          {lifespan}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

/**
 * The union node is deliberately tiny — visually it reads as the junction
 * between two partners, not as a person.
 */
function UnionNode() {
  return (
    <div className="h-3.5 w-3.5 rounded-full border-2 border-stone-400 bg-white dark:border-stone-500 dark:bg-stone-800">
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { person: PersonNode, union: UnionNode };

export function FamilyTree({ graph }: { graph: FamilyGraph }) {
  const { nodes, edges } = useMemo(() => layoutFamilyGraph(graph), [graph]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        // Layout is computed, never stored. Nobody positions anything by hand,
        // so there is no way to drag the family into a mess.
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
