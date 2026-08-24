"use client";

import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "@xyflow/react/dist/style.css";

import { PersonPanel } from "@/components/PersonPanel";
import type { FamilyGraph } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";
import { layoutFamilyGraph } from "@/lib/tree-layout";
import { panToReveal, toRect, unobscuredRegion } from "@/lib/tree-viewport";

function PersonNode({
  data,
  selected,
}: NodeProps<Node<Record<string, unknown>>>) {
  const name = String(data.name ?? "");
  const lifespan = String(data.lifespan ?? "");

  return (
    <div
      className={`w-44 rounded-panel border bg-paper px-3 py-2 shadow-sm ${
        selected ? "border-link ring-2 ring-link" : "border-rule"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="truncate font-medium text-ink">{name}</div>
      {lifespan ? (
        <div className="text-note text-ink-muted">{lifespan}</div>
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
    <div className="h-3.5 w-3.5 rounded-full border-2 border-rule bg-paper">
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { person: PersonNode, union: UnionNode };

/**
 * The provider is what `useReactFlow` needs, and it has to sit *above* the
 * `<ReactFlow>` element rather than inside it — the canvas below reads and
 * writes the viewport in order to pan out from under the detail panel, and a
 * hook cannot reach a context its own component renders.
 */
export function FamilyTree({ graph }: { graph: FamilyGraph }) {
  return (
    <ReactFlowProvider>
      <FamilyTreeCanvas graph={graph} />
    </ReactFlowProvider>
  );
}

function FamilyTreeCanvas({ graph }: { graph: FamilyGraph }) {
  const layout = useMemo(() => layoutFamilyGraph(graph), [graph]);

  /**
   * The nodes are held in state rather than passed straight from the layout,
   * and `onNodesChange` is what makes that a *controlled* flow rather than a
   * half-controlled one.
   *
   * This is load-bearing, not ceremony. React Flow applies a selection to its
   * own store only when the flow is uncontrolled (`defaultNodes`); given a
   * `nodes` prop it emits a change and expects the owner to apply it. Passing
   * `nodes` with no `onNodesChange` — which is what this component did before
   * anything read the selection — means clicking a node, pressing Enter on a
   * focused one, and clicking the empty canvas all produce changes that go
   * nowhere. Applying them here is what gives all three routes a selection to
   * open the panel from, without a code path per input device.
   *
   * Layout is still computed and never stored: this state is seeded from the
   * layout and re-seeded whenever the graph changes, and the only changes ever
   * applied to it are selections — dragging is off.
   */
  const [nodes, setNodes] = useState<Node[]>(layout.nodes);
  const [seededFrom, setSeededFrom] = useState(layout);

  if (seededFrom !== layout) {
    // A different graph arrived — a soft navigation back to this route with
    // fresh data. Re-seed from the new layout, selection included, since the
    // person the panel was open on may no longer be in it. Adjusting state
    // during render rather than in an effect is React's own answer to
    // "reset state when a prop changes": the component re-renders before
    // anything is committed, so the stale nodes are never painted.
    setSeededFrom(layout);
    setNodes(layout.nodes);
  }

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const selectedId = useMemo(
    () =>
      nodes.find((node) => node.selected && node.type === "person")?.id ?? null,
    [nodes],
  );
  const detail = useMemo(
    () => (selectedId === null ? null : derivePersonDetail(graph, selectedId)),
    [graph, selectedId],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const { getViewport, setViewport } = useReactFlow();

  /**
   * The wrapper React Flow renders around a node: the element that is in the
   * tab order and the element with a measurable box. The custom component
   * inside it is neither, so both the focus handling and the pan want this one.
   *
   * Scanned and compared rather than interpolated into an attribute selector.
   * An id reaches this from the database and, in E2-T4, from the query string,
   * and building a selector out of one means escaping it correctly forever.
   * Reading `dataset.id` off each candidate has nothing to escape.
   */
  const nodeElement = useCallback((personId: string): HTMLElement | null => {
    const wrappers =
      containerRef.current?.querySelectorAll<HTMLElement>(".react-flow__node");
    for (const wrapper of wrappers ?? []) {
      if (wrapper.dataset.id === personId) return wrapper;
    }
    return null;
  }, []);

  /** Following a relative's link: the same selection a click would make. */
  const selectPerson = useCallback((personId: string) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === personId
          ? { ...node, selected: true }
          : node.selected
            ? { ...node, selected: false }
            : node,
      ),
    );
  }, []);

  const close = useCallback(() => {
    setNodes((current) =>
      current.map((node) =>
        node.selected ? { ...node, selected: false } : node,
      ),
    );
  }, []);

  /**
   * "Focus returns to the node."
   *
   * Watching the selection rather than hanging off the close button, because
   * only one of the ways out of the panel goes through this component's own
   * handler. Escape from a focused node and a click on the empty canvas are
   * both React Flow deselecting on its own; a focus restore living in `close`
   * would quietly not happen for either, and the panel would still look like
   * it worked.
   *
   * The guard is what keeps this from being a focus thief. When the panel
   * unmounts the browser drops focus on `<body>`, which is the case worth
   * rescuing; anywhere else means the reader has already moved on and the
   * canvas has no business pulling them back.
   */
  const lastSelectedId = useRef<string | null>(null);

  useEffect(() => {
    const previous = lastSelectedId.current;
    lastSelectedId.current = selectedId;
    if (selectedId !== null || previous === null) return;

    const active = document.activeElement;
    if (active === null || active === document.body) {
      nodeElement(previous)?.focus();
    }
  }, [selectedId, nodeElement]);

  /**
   * "The panel does not obscure the selected node — pan the canvas if needed."
   *
   * Measured rather than assumed, and in an effect so that the panel is
   * already laid out when its rectangle is read. The geometry itself is in
   * `lib/tree-viewport.ts`; all that happens here is reading three boxes and
   * handing the result to the viewport.
   *
   * The panel has no entry transition, and that is the reason: a sliding
   * element measures wherever the animation currently has it, so the canvas
   * would pan to clear a position the panel is about to leave.
   */
  useEffect(() => {
    if (selectedId === null) return;

    const container = containerRef.current;
    const node = nodeElement(selectedId);
    if (!container || !node) return;

    const region = unobscuredRegion(
      toRect(container.getBoundingClientRect()),
      panelRef.current
        ? toRect(panelRef.current.getBoundingClientRect())
        : null,
    );
    const { dx, dy } = panToReveal(toRect(node.getBoundingClientRect()), region);
    if (dx === 0 && dy === 0) return;

    const viewport = getViewport();
    setViewport(
      { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
      { duration: 200 },
    );
  }, [selectedId, nodeElement, getViewport, setViewport]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        fitView
        // Layout is computed, never stored. Nobody positions anything by hand,
        // so there is no way to drag the family into a mess.
        nodesDraggable={false}
        nodesConnectable={false}
        onNodesChange={onNodesChange}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {detail === null ? null : (
        <PersonPanel
          ref={panelRef}
          detail={detail}
          onSelectPerson={selectPerson}
          onClose={close}
        />
      )}
    </div>
  );
}
