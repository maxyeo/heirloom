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
  useNodesInitialized,
  useReactFlow,
  type FitViewOptions,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "@xyflow/react/dist/style.css";

import { AddChildForm } from "@/components/AddChildForm";
import type { IndividualFormAction } from "@/components/AddPersonPanel";
import { AddSpouseForm } from "@/components/AddSpouseForm";
import { EditPerson } from "@/components/EditPersonForm";
import { PersonEntry } from "@/components/PersonEntry";
import { PersonPanel } from "@/components/PersonPanel";
import { PersonRemoval } from "@/components/PersonRemoval";
import { SetParentsForm } from "@/components/SetParentsForm";
import { TreeEmptyState, TreeStartHint } from "@/components/TreeOnboarding";
import { UnionMerge } from "@/components/UnionMerge";
import { UnionOrder } from "@/components/UnionOrder";
import type { AddChildFormAction } from "@/lib/child-form-state";
import { type EntryLink, findEntry, unlinkedEntries } from "@/lib/entry-link";
import type { PersonEntryActions } from "@/lib/entry-link-state";
import type { FamilyGraph } from "@/lib/family-graph";
import type { SetParentsFormAction } from "@/lib/parents-form-state";
import { derivePersonDetail } from "@/lib/person-detail";
import type { AddSpouseFormAction } from "@/lib/spouse-form-state";
import type { ReorderUnionsFormAction } from "@/lib/union-order-state";
import { layoutFamilyGraph } from "@/lib/tree-layout";
import { treeOnboarding } from "@/lib/tree-onboarding";
import {
  linkedPersonId,
  withSelection,
  type PersonLink,
} from "@/lib/tree-selection";
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
 * The default for `entries`, hoisted so it is the same array on every render.
 * A literal in the parameter list would be a new one each time, which is a new
 * dependency for the memos below and a re-filter of a list that did not change.
 */
const EMPTY_ENTRIES: readonly EntryLink[] = [];

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
   * The add-child action (E3-T5), passed down for exactly the same reasons as
   * the one above — and separately from it, so that a canvas may offer either
   * flow, both, or neither.
   */
  addChildAction?: AddChildFormAction;
  /**
   * The set-parents action (E3-T6), passed down for exactly the same reasons
   * as the two above — and separately from them, so that a canvas may offer
   * any of the flows, all of them, or none.
   */
  setParentsAction?: SetParentsFormAction;
  /**
   * The edit-person action (E3-T3), passed down for exactly the reasons
   * `addSpouseAction` is — and optional for the same one: without it the
   * panel is the read-only record it always was, which is what keeps this
   * whole component tree mountable in jsdom.
   */
  updateIndividualAction?: IndividualFormAction;
  /**
   * The add-person action (E3-T2), for the empty state's own call to action
   * (E3-T9). Optional for the same reason and with the same consequence: a
   * canvas given none is read-only, and the invitation it shows on an empty
   * database is words rather than words and a button.
   */
  createIndividualAction?: IndividualFormAction;
  /**
   * The union reorder action (E3-T7), for the sequence editor in the detail
   * panel's footer. Optional for the same reason as every action above it: a
   * canvas given none is read-only, and the panel simply has no ordering
   * control.
   */
  reorderUnionsAction?: ReorderUnionsFormAction;
  /**
   * The address bar, as something the canvas can read and write (E2-T4).
   *
   * Optional like every action above it, and for a closely related reason: the
   * hook that reads a query parameter needs the App Router's own providers,
   * which no test that mounts this canvas has.
   * `components/DeepLinkedFamilyTree.tsx` supplies it on the route; a canvas
   * given none selects and deselects exactly as it did before there was a URL
   * involved.
   */
  personLink?: PersonLink;
  /**
   * Every wiki entry, as something a person can be linked to (E2-T2).
   *
   * Not part of the graph, and deliberately: joining `pages` into
   * `getFamilyGraph` would carry a slug and a title on all of the hundreds of
   * people on the canvas in order to render one link on the one panel that is
   * open. `lib/entry-link.ts` matches the two lists instead, in the browser,
   * for the same reason the layout is computed there — both are small, and
   * moving between people then costs no request.
   *
   * Defaults to empty, so a canvas given none simply has no entry to show.
   */
  entries?: readonly EntryLink[];
  /**
   * The three doors onto `individuals.page_id` (E2-T2), passed down for
   * exactly the reasons every action above is — and as one prop, because they
   * are one feature. Optional, with the same consequence: a canvas given none
   * shows the entry a person already has and offers nothing further.
   */
  entryActions?: PersonEntryActions;
}

export function FamilyTree({
  graph,
  addSpouseAction,
  addChildAction,
  setParentsAction,
  updateIndividualAction,
  createIndividualAction,
  reorderUnionsAction,
  personLink,
  entries,
  entryActions,
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
      <FamilyTreeCanvas
        graph={graph}
        addSpouseAction={addSpouseAction}
        addChildAction={addChildAction}
        setParentsAction={setParentsAction}
        reorderUnionsAction={reorderUnionsAction}
        updateIndividualAction={updateIndividualAction}
        personLink={personLink}
        entries={entries}
        entryActions={entryActions}
      />
    </ReactFlowProvider>
  );
}

function FamilyTreeCanvas({
  graph,
  addSpouseAction,
  addChildAction,
  setParentsAction,
  reorderUnionsAction,
  updateIndividualAction,
  personLink,
  entries = EMPTY_ENTRIES,
  entryActions,
}: FamilyTreeProps) {
  const layout = useMemo(() => layoutFamilyGraph(graph), [graph]);

  /**
   * How far along the tree is (E3-T9). Only the `unconnected` stage reaches
   * this component — `FamilyTree` above has already sent an empty graph
   * somewhere else — and it is what decides whether the canvas says anything
   * beyond the cards themselves.
   */
  const onboarding = useMemo(() => treeOnboarding(graph), [graph]);

  /**
   * Who the URL is asking for (E2-T4), resolved against the graph rather than
   * taken at its word — `null` when it names nobody this tree has.
   *
   * That resolution is the whole of "unknown or malformed id falls back to the
   * default view without erroring": an id that answers to nobody is
   * indistinguishable here from no id at all, and every line below this one is
   * written against a person who exists.
   */
  const linkedId = useMemo(
    () => (personLink ? linkedPersonId(graph, personLink.personId) : null),
    [graph, personLink],
  );

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
   *
   * A deep link is applied to the *seed* rather than in an effect (E2-T4), so
   * that `/tree?person=<id>` renders with the panel already open and the node
   * already marked, instead of painting the plain canvas first and opening a
   * panel over it a frame later.
   */
  const [nodes, setNodes] = useState<Node[]>(() =>
    withSelection(layout.nodes, linkedId),
  );
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
    const keep = nodes.find((node) => node.selected)?.id ?? null;
    setSeededFrom(layout);
    setNodes(withSelection(layout.nodes, keep));
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
   * The same person as `detail`, but as the row rather than as the reading of
   * it. E3-T3's form prefills ten inputs, and `PersonDetail` has already
   * turned a birth into "about 12 March 1890" and a name into one string — so
   * the edit affordance needs the record the panel was derived *from*.
   */
  const person = useMemo(
    () =>
      selectedId === null
        ? null
        : (graph.people.find((candidate) => candidate.id === selectedId) ??
          null),
    [graph, selectedId],
  );

  /**
   * The entry this person is linked to, and the entries nobody is (E2-T2).
   *
   * Both are derived rather than fetched: `page_id` is already on the graph
   * and the entries arrived with it, so opening one panel after another costs
   * no request — the same property that makes the relatives' links work.
   */
  const entry = useMemo(
    () => findEntry(entries, person?.pageId ?? null),
    [entries, person],
  );
  const linkableEntries = useMemo(
    () => unlinkedEntries(entries, graph.people),
    [entries, graph.people],
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

  /**
   * The same again for the add-child flow (E3-T5), held as its own id rather
   * than as a mode of the one above. Two independent pieces of state cannot
   * both be open — the render below picks one — and keeping them apart means
   * neither flow can be left half-open by the other closing.
   */
  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const addingChild = addingChildFor !== null && addingChildFor === selectedId;

  /**
   * And once more for the set-parents flow (E3-T6). Three independent ids
   * rather than one mode, for the reason above: the render below picks exactly
   * one, and keeping them apart means no flow can be left half-open by
   * another closing.
   */
  const [settingParentsFor, setSettingParentsFor] = useState<string | null>(
    null,
  );
  const settingParents =
    settingParentsFor !== null && settingParentsFor === selectedId;

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
    setNodes((current) => withSelection(current, personId));
  }, []);

  const close = useCallback(() => {
    setNodes((current) => withSelection(current, null));
  }, []);

  /**
   * "Focus returns to the node."
   *
   * Handed to the panel rather than hung off the close button, because only
   * one of the ways out goes through this component's own handler. Escape from
   * a focused node and a click on the empty canvas are both React Flow
   * deselecting on its own; a focus restore living in `close` would quietly
   * not happen for either, and the panel would still look like it worked. The
   * panel unmounting is the one event all of them have in common, which is
   * what `useDismissableSurface` hangs this on (`YEO-83`).
   *
   * The guard that keeps this from being a focus thief moved with it: when the
   * panel unmounts the browser drops focus on `<body>`, which is the case
   * worth rescuing, and anywhere else means the reader has already moved on
   * and the canvas has no business pulling them back. See `restoreFocus` in
   * `components/surface-stack.ts`.
   *
   * Resolved when the panel goes rather than held as an element, because a
   * deep link opens the panel before React Flow has drawn a node to go back
   * to. Memoised only so the panel is not handed a new function every render.
   */
  const returnFocusToNode = useCallback(
    () => (selectedId === null ? null : nodeElement(selectedId)),
    [selectedId, nodeElement],
  );

  /**
   * The selection and the URL, kept saying the same thing (E2-T4).
   *
   * One effect and one ref, because the two directions are the same
   * conversation and running them as separate effects makes them argue: a
   * click changes the selection a whole render before the router has caught up
   * with the URL it is about to write, so an effect watching the URL on its own
   * would read `null`, conclude that nobody is selected, and undo the click.
   *
   * `mirrored` is the id both sides last agreed on, which is what tells them
   * apart. Whichever side no longer matches it is the side that moved:
   *
   * - the **URL** moved — a deep link opened from a wiki entry, or the
   *   browser's back and forward buttons — so the canvas follows it;
   * - the **canvas** moved — a click, Enter on a focused node, a relative's
   *   link in the panel, Escape, the close button, or a person deleted out
   *   from under an open panel — so the URL follows it.
   *
   * The URL is read first for no deeper reason than that one of them has to
   * be; the two cannot both move between renders.
   */
  const mirrored = useRef<string | null>(linkedId);

  useEffect(() => {
    if (!personLink) return;

    if (linkedId !== mirrored.current) {
      mirrored.current = linkedId;
      setNodes((current) => withSelection(current, linkedId));
      return;
    }

    if (selectedId !== mirrored.current) {
      mirrored.current = selectedId;
      personLink.onChange(selectedId);
    }
  }, [personLink, linkedId, selectedId]);

  /**
   * Whether the canvas has settled into the view it arrives at.
   *
   * React Flow fits the viewport in the same store update that records the
   * measurements it was waiting for, and that update is strictly *after* this
   * component's first effects have run. On a deep link the ordering matters:
   * the pan below would compute a translation, and the fit would then throw it
   * away and leave the node wherever the fit put it — which on a narrow
   * viewport can be underneath a bottom sheet 60% of the canvas tall. Reading
   * the measurement instead means the pan re-runs once, against the viewport
   * the reader is actually looking at.
   *
   * Derived rather than latched, so there is no state to keep in step. It is
   * true from the first render when nobody was deep-linked, which is what
   * leaves an ordinary click — long after any of this — behaving exactly as it
   * did before E2-T4.
   */
  const nodesInitialized = useNodesInitialized();
  const arrived = linkedId === null || nodesInitialized;

  /**
   * Fit, but never magnify (E3-T9). React Flow's fitView zooms up to 2x by
   * default, which is invisible on a family — a dozen cards always need
   * zooming *out* — and absurd on the first one: a single card blown up to
   * twice its size, alone in the middle of the viewport, is most of what makes
   * a one-person tree look broken rather than new. Capping the fit at 1
   * renders the lone card at the size every other card on this canvas is
   * drawn at.
   *
   * And fit onto the deep-linked person when the URL named one (E2-T4). The
   * criterion is "opens the tree centred on that person", and a fit over the
   * whole family meets "on screen" without meeting "centred" — past a few
   * dozen people it is a highlighted card the size of a stamp. Held in state
   * so it is read once, at mount, which is also the only time React Flow reads
   * it: a later change to `?person=` is navigation around a canvas the reader
   * has already framed, and re-fitting under them would throw away their pan
   * and zoom.
   */
  const [fitViewOptions] = useState<FitViewOptions>(() =>
    linkedId === null
      ? { maxZoom: 1 }
      : { maxZoom: 1, nodes: [{ id: linkedId }] },
  );

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
    if (!arrived || selectedId === null) return;

    const container = containerRef.current;
    const node = nodeElement(selectedId);
    if (!container || !node) return;

    const region = unobscuredRegion(
      toRect(container.getBoundingClientRect()),
      panelRef.current
        ? toRect(panelRef.current.getBoundingClientRect())
        : null,
    );
    const { dx, dy } = panToReveal(
      toRect(node.getBoundingClientRect()),
      region,
    );
    if (dx === 0 && dy === 0) return;

    const viewport = getViewport();
    setViewport(
      { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
      { duration: 200 },
    );
  }, [arrived, selectedId, nodeElement, getViewport, setViewport]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        fitView
        // Capped at 1, and aimed at the deep-linked person when there is one.
        // Both are explained where the value is built, above.
        fitViewOptions={fitViewOptions}
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

      {/*
        Losing the selection unmounts everything below, E3-T3's edit form
        included — and a React unmount is the one exit its unsaved-changes
        check cannot intervene in, since it is neither a browser navigation
        nor a dismissal the form was asked about. That is safe rather than
        overlooked: while the edit dialogue is open its backdrop covers this
        whole canvas, so nothing here can deselect anybody. The only way the
        person leaves the graph under it is a delete in *another* tab, which
        the form already answers for — `updateIndividualAction` reports
        `not-found`, and the correction is still on screen to copy out of.
      */}
      {detail === null ? null : settingParents && setParentsAction ? (
        <SetParentsForm
          action={setParentsAction}
          person={{ id: detail.id, name: detail.name }}
          /*
            The whole graph, not this person's derived detail: every family on
            the canvas is a possible answer, and the cycle filter is a walk
            over the graph rather than a fact about one record.
          */
          graph={graph}
          onSaved={() => setSettingParentsFor(null)}
          onCancel={() => setSettingParentsFor(null)}
        />
      ) : addingChild && addChildAction ? (
        <AddChildForm
          action={addChildAction}
          person={{ id: detail.id, name: detail.name }}
          /*
            The unions this person belongs to, already derived by
            `derivePersonDetail` — which is where the choice of family comes
            from and where each option gets the other parent's name.
          */
          unions={detail.spouses}
          people={graph.people}
          onSaved={() => setAddingChildFor(null)}
          onCancel={() => setAddingChildFor(null)}
        />
      ) : addingSpouse && addSpouseAction ? (
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
            The canvas is the only thing that knows which DOM node opened the
            panel — the panel is handed a person, not a wrapper element to
            scan for.
          */
          returnFocus={returnFocusToNode}
          /*
            E2-T2's entry link, composed into its own slot above the relatives
            rather than into the footer: it is not an edit to the record, it is
            the other half of the product. The panel is handed the answer — an
            entry or none — and does no looking up of its own.
          */
          entryLink={
            <PersonEntry
              personId={detail.id}
              personName={detail.name}
              entry={entry}
              options={linkableEntries}
              actions={entryActions}
            />
          }
          /*
            E3-T8's remove/detach affordance, composed in rather than built
            into the panel. It needs the whole graph — the confirmation has to
            name the real unions and child links that a delete would take —
            and the panel only ever holds one person's derived detail.
          */
          footer={
            <>
              {/*
                E3-T3's edit form, composed into the same slot for the same
                reason: correcting a record is not something a read-only panel
                should have to know how to do, and putting it here rather than
                in `PersonPanel` keeps both features off a file two sibling
                tickets are editing.
              */}
              {updateIndividualAction && person ? (
                <EditPerson person={person} action={updateIndividualAction} />
              ) : null}
              {/*
                E3-T7's sequence editor. Between the edit form and the
                removals because that is the order the three do damage in:
                correcting a record, restating an order, and deleting. It
                renders nothing at all below two unions, which is most people.
              */}
              {reorderUnionsAction ? (
                <UnionOrder
                  action={reorderUnionsAction}
                  personId={detail.id}
                  spouses={detail.spouses}
                />
              ) : null}
              {/*
                E3-T10's duplicate merge (`YEO-82`), between the sequence
                editor and the removals for the same reason the sequence
                editor sits where it does: it is a correction to what was
                recorded rather than a deletion of it, and — like that one —
                it renders nothing at all unless this person actually has two
                families recorded with the same partner, which is nearly
                everybody.
              */}
              <UnionMerge graph={graph} personId={detail.id} />
              <PersonRemoval graph={graph} personId={detail.id} />
            </>
          }
          onAddSpouse={
            addSpouseAction ? () => setAddingSpouseFor(detail.id) : undefined
          }
          onAddChild={
            addChildAction ? () => setAddingChildFor(detail.id) : undefined
          }
          onSetParents={
            setParentsAction ? () => setSettingParentsFor(detail.id) : undefined
          }
        />
      )}
    </div>
  );
}
