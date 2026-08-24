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

import type { IndividualFormAction } from "@/components/AddPersonPanel";
import { AddSpouseForm } from "@/components/AddSpouseForm";
import { PersonPanel } from "@/components/PersonPanel";
import { PersonRemoval } from "@/components/PersonRemoval";
import { TreeEmptyState, TreeStartHint } from "@/components/TreeOnboarding";
import type { FamilyGraph } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";
import type { AddSpouseFormAction } from "@/lib/spouse-form-state";
import { layoutFamilyGraph } from "@/lib/tree-layout";
import { treeOnboarding } from "@/lib/tree-onboarding";
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
export interface FamilyTreeProps {
  graph: FamilyGraph;
  /**
   * The add-spouse action (E3-T4), passed down from the Server Component that
   * renders the canvas.
   *
   * Optional, and the canvas is read-only without it. That is what keeps the
   * whole component tree mountable in jsdom: the action module reaches Auth.js
   * and `@/db`, neither of which `npm test` has an environment for. See
   * `AddSpouseFormAction`.
   */
  addSpouseAction?: AddSpouseFormAction;
  /**
   * The add-person action (E3-T2), for the empty state's own call to action
   * (E3-T9). Optional for the same reason and with the same consequence: a
   * canvas given none is read-only, and the invitation it shows on an empty
   * database is words rather than words and a button.
   */
  createIndividualAction?: IndividualFormAction;
}

export function FamilyTree({
  graph,
  addSpouseAction,
  createIndividualAction,
}: FamilyTreeProps) {
  /**
   * An empty database gets an invitation instead of a canvas (E3-T9).
   *
   * The branch is here, above the provider, rather than inside the canvas
   * below: `FamilyTreeCanvas` is a dozen hooks deep before it renders
   * anything, and a component that returns early past them is a component
   * where the next effect added has to remember it. Nothing is lost, because
   * a graph with nobody in it has no layout, no selection and no viewport to
   * preserve — there is nothing for React Flow to do.
   */
  if (graph.people.length === 0) {
    return <TreeEmptyState action={createIndividualAction} />;
  }

  return (
    <ReactFlowProvider>
      <FamilyTreeCanvas graph={graph} addSpouseAction={addSpouseAction} />
    </ReactFlowProvider>
  );
}

function FamilyTreeCanvas({ graph, addSpouseAction }: FamilyTreeProps) {
  const layout = useMemo(() => layoutFamilyGraph(graph), [graph]);

  /**
   * How far along the tree is (E3-T9). Only the `unconnected` stage reaches
   * this component — `FamilyTree` above has already sent an empty graph
   * somewhere else — and it is what decides whether the canvas says anything
   * beyond the cards themselves.
   */
  const onboarding = useMemo(() => treeOnboarding(graph), [graph]);

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
    /**
     * A different graph arrived — a soft navigation back to this route, or a
     * write that revalidated `/tree`. Re-seed from the new layout. Adjusting
     * state during render rather than in an effect is React's own answer to
     * "reset state when a prop changes": the component re-renders before
     * anything is committed, so the stale nodes are never painted.
     *
     * The selection is carried across when the person is still in the graph.
     * Every E3 write revalidates this route, so dropping it would mean that
     * adding a spouse (E3-T4) closed the panel of the person you added them
     * to, at the exact moment you wanted to look at the result. A person who
     * is *not* in the new graph — deleted in another tab, or by E3-T8 — has no
     * node to be selected, and the panel closes because there is nothing left
     * to show.
     */
    const keep = nodes.find((node) => node.selected)?.id;
    setSeededFrom(layout);
    setNodes(
      keep === undefined
        ? layout.nodes
        : layout.nodes.map((node) =>
            node.id === keep ? { ...node, selected: true } : node,
          ),
    );
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

  /**
   * Which person's add-spouse form is open (E3-T4), rather than a boolean.
   *
   * Holding the id means the form closes on its own when the author selects
   * somebody else — no effect watching the selection, and no way for a form
   * headed "Add a spouse for Rose" to be submitted against Thomas.
   */
  const [addingSpouseFor, setAddingSpouseFor] = useState<string | null>(null);
  const addingSpouse =
    addingSpouseFor !== null && addingSpouseFor === selectedId;

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
        /*
          Fit, but never magnify (E3-T9). React Flow's fitView zooms up to 2x
          by default, which is invisible on a family — a dozen cards always
          need zooming *out* — and absurd on the first one: a single card
          blown up to twice its size, alone in the middle of the viewport, is
          most of what makes a one-person tree look broken rather than new.
          Capping the fit at 1 renders the lone card at the size every other
          card on this canvas is drawn at.
        */
        fitViewOptions={{ maxZoom: 1 }}
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

      {/*
        People on the canvas and nothing joining them (E3-T9). Hidden while a
        panel is open, because the panel is both the answer to the hint and,
        on a narrow viewport, sitting on top of it.
      */}
      {onboarding.stage === "unconnected" && detail === null ? (
        <TreeStartHint person={onboarding.person} />
      ) : null}

      {detail === null ? null : addingSpouse && addSpouseAction ? (
        <AddSpouseForm
          action={addSpouseAction}
          person={{ id: detail.id, name: detail.name }}
          people={graph.people}
          /*
            The write revalidated `/tree`, so a fresh graph is already on its
            way into this component; closing the form is all that is left to
            do, and the panel behind it re-renders with the new spouse in the
            list.
          */
          onSaved={() => setAddingSpouseFor(null)}
          onCancel={() => setAddingSpouseFor(null)}
        />
      ) : (
        <PersonPanel
          ref={panelRef}
          detail={detail}
          onSelectPerson={selectPerson}
          onClose={close}
          /*
            E3-T8's remove/detach affordance, composed in rather than built
            into the panel. It needs the whole graph — the confirmation has to
            name the real unions and child links that a delete would take —
            and the panel only ever holds one person's derived detail.
          */
          footer={<PersonRemoval graph={graph} personId={detail.id} />}
          onAddSpouse={
            addSpouseAction
              ? () => setAddingSpouseFor(detail.id)
              : undefined
          }
        />
      )}
    </div>
  );
}
