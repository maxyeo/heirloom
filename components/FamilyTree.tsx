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
import { DescentEdge } from "@/components/DescentEdge";
import { EditPerson } from "@/components/EditPersonForm";
import { EditUnionForm } from "@/components/EditUnionForm";
import { PersonEntry } from "@/components/PersonEntry";
import { PersonPanel } from "@/components/PersonPanel";
import { PersonPortrait } from "@/components/PersonPortrait";
import { PersonRemoval } from "@/components/PersonRemoval";
import { SetParentsForm } from "@/components/SetParentsForm";
import { SkipLink } from "@/components/SkipLink";
import { TreeLegend } from "@/components/TreeLegend";
import { personSelectedOnCanvas } from "@/components/tree-panels";
import { TreeEmptyState, TreeStartHint } from "@/components/TreeOnboarding";
import { UnionMerge } from "@/components/UnionMerge";
import { UnionOrder } from "@/components/UnionOrder";
import type { AddChildFormAction } from "@/lib/child-form-state";
import { type EntryLink, findEntry, unlinkedEntries } from "@/lib/entry-link";
import type { PersonEntryActions } from "@/lib/entry-link-state";
import type { FamilyGraph } from "@/lib/family-graph";
import type { SetParentsFormAction } from "@/lib/parents-form-state";
import { derivePersonDetail, type PersonDetail } from "@/lib/person-detail";
import type { AddSpouseFormAction } from "@/lib/spouse-form-state";
import type { UpdateUnionFormAction } from "@/lib/union-edit-state";
import type { ReorderUnionsFormAction } from "@/lib/union-order-state";
import { PERSON_WIDTH, layoutFamilyGraph } from "@/lib/tree-layout";
import { treeLegend } from "@/lib/tree-legend";
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
  /**
   * The thumbnail's path, or null (E5-T4, `YEO-44`).
   *
   * Read defensively because `data` is `Record<string, unknown>` — React
   * Flow's node data is untyped by construction, so this is the boundary
   * where it becomes a value rather than a cast.
   *
   * `lib/tree-layout.ts` decided *which* image this is, and it is the small
   * one: the canvas draws every person at once, and pulling the originals
   * here is the failure this ticket exists to prevent.
   */
  const portraitSrc =
    typeof data.portraitSrc === "string" ? data.portraitSrc : null;

  return (
    <div
      /**
       * The width is `PERSON_WIDTH` from `lib/tree-layout.ts`, written as a
       * style rather than a `w-*` class for the reason `PersonPortrait` gives
       * about its own box: dagre reserved this many pixels, and a second
       * spelling of the number in a different notation is a spelling that can
       * drift into cards that overlap.
       */
      style={{ width: PERSON_WIDTH }}
      className={`flex items-center gap-2 rounded-panel border bg-paper px-3 py-2 shadow-sm ${
        selected ? "border-link ring-2 ring-link" : "border-rule"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <PersonPortrait src={portraitSrc} name={name} size="node" />
      {/*
        `min-w-0` is what makes `truncate` work inside a flex row: without it
        this column's minimum width is its content, so a long name would push
        the card wider than the box dagre reserved instead of being cut off.
      */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-ink">{name}</div>
        {lifespan ? (
          <div className="text-note text-ink-muted">{lifespan}</div>
        ) : null}
      </div>
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
 * The one custom edge, and the only kind of line on this canvas that is not
 * React Flow's own `smoothstep`. See `components/DescentEdge.tsx` for what it
 * draws differently and why.
 */
const edgeTypes = { descent: DescentEdge };

/**
 * Where "skip the family tree" lands (`YEO-108`).
 *
 * `YEO-69` put every person in the tab order, which is what made the canvas
 * reachable and also made it two hundred stops long on a family of two
 * hundred. WCAG 2.4.1 asks for a way over a repeated block, and the block is
 * the canvas — so the way over it belongs to the canvas rather than to
 * `app/tree/page.tsx`. Anywhere the canvas is mounted it brings its own
 * bypass, and the marker sits immediately after the flow, so that whatever is
 * put below the canvas next is what the skip arrives in front of. Nothing
 * currently is; that is precisely the assumption `YEO-69` recorded and this
 * ticket exists to stop depending on.
 *
 * Not in `RESERVED_HEADING_IDS`, unlike the shell's ids: this one renders only
 * on `/tree`, and an article body and a tree canvas are never in the same
 * document to collide.
 */
export const TREE_SKIP_TARGET_ID = "tree-canvas-end";

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
   * The edit-union action, for the correction dialogue the detail panel's
   * spouse rows open. Optional for the same reason as every action around it:
   * a canvas given none lists the unions without offering to fix them.
   */
  updateUnionAction?: UpdateUnionFormAction;
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
  updateUnionAction,
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
        updateUnionAction={updateUnionAction}
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
  updateUnionAction,
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
   * The key to the canvas's lines (E10-T5), or an empty list when this family
   * has no dash to explain — which is most of them. `lib/tree-legend.ts`
   * decides; the corner it is drawn in is `components/TreeLegend.tsx`'s.
   */
  const legend = useMemo(() => treeLegend(graph), [graph]);

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
   * Which union's correction dialogue is open, by id.
   *
   * An id rather than a boolean for the reason `addingSpouseFor` is one, with
   * one addition: the union has to be *found* in the graph on every render, so
   * a union deleted or merged away in another tab closes this dialogue when
   * the revalidation lands rather than leaving a form open over a row that is
   * no longer there. The lookup below is the whole of that behaviour.
   */
  const [editingUnionId, setEditingUnionId] = useState<string | null>(null);
  const editingUnion = useMemo(
    () =>
      editingUnionId === null
        ? null
        : (graph.unions.find((union) => union.id === editingUnionId) ?? null),
    [graph.unions, editingUnionId],
  );

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
   * "Focus returns to the Edit button the correction dialogue came from."
   *
   * Without it a keyboard author closes the dialogue and lands on `<body>`,
   * behind the very panel they were reading, with no way back but tabbing in
   * from the top of the document — the gap `EditPersonForm` closes by holding
   * a ref to its own trigger. This one cannot: the trigger belongs to
   * `PersonPanel`, which renders a route in and knows nothing about the
   * dialogue behind it. So the button is found the way a node is, by the id
   * they both hold.
   *
   * Resolved when the dialogue goes rather than held as an element, because
   * the panel behind it re-renders on every revalidation and the button that
   * opened this is not the same DOM node it was.
   *
   * Scanned and compared rather than interpolated into an attribute selector,
   * for the reason `nodeElement` gives above: an id reaches this from the
   * database, and building a selector out of one means escaping it correctly
   * forever. `CSS.escape` would be the escape, and jsdom implements no `CSS`
   * at all — so the version of this that read well was one that threw
   * `TypeError` in every test that closed the dialogue, which is to say in
   * every test anybody would write for this behaviour. Reading
   * `dataset.editUnion` off each candidate has nothing to escape.
   */
  const returnFocusToEditButton = useCallback((): HTMLElement | null => {
    if (editingUnionId === null) return null;
    const buttons = document.querySelectorAll<HTMLElement>("[data-edit-union]");
    for (const button of buttons) {
      if (button.dataset.editUnion === editingUnionId) return button;
    }
    return null;
  }, [editingUnionId]);

  /**
   * Selecting somebody takes the add-person panel off the right-hand column.
   *
   * Hung off `selectedId` rather than off a click handler because there is no
   * one click to hang it off: a node is selected by a press, by Enter on a
   * focused node, and by a relative's link inside the record — the three
   * routes `onNodesChange` exists to collapse into one piece of state. This is
   * the same reasoning that put the URL mirror below on the state rather than
   * on the events that change it.
   *
   * Only a selection, never a deselection: closing the record must not close a
   * panel the author opened deliberately. And `personSelectedOnCanvas` decides
   * on its own whether the add-person panel has anything in it worth keeping —
   * see `components/tree-panels.ts`, which is also why this does not care that
   * the effect re-runs for a deep link arriving with nothing open.
   */
  useEffect(() => {
    if (selectedId === null) return;
    personSelectedOnCanvas();
  }, [selectedId]);

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
      {/*
        The last stop before the family (`YEO-108`). It has to be
        *before* the flow in the document, because that is the whole of what
        "before" means to Tab — React Flow's nodes carry no `tabindex` above 0
        and neither does this, so document order is the order.
      */}
      <SkipLink targetId={TREE_SKIP_TARGET_ID}>Skip the family tree</SkipLink>

      <ReactFlow
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        // Capped at 1, and aimed at the deep-linked person when there is one.
        // Both are explained where the value is built, above.
        fitViewOptions={fitViewOptions}
        // Layout is computed, never stored. Nobody positions anything by hand,
        // so there is no way to drag the family into a mess.
        nodesDraggable={false}
        nodesConnectable={false}
        /**
         * Every line in the family is a tab stop otherwise (E10-T5).
         *
         * React Flow's `edgesFocusable` defaults to **true**, and the edges
         * are rendered before the nodes in the document, so the default tab
         * order on a canvas of two hundred people is a couple of hundred
         * lines followed by the people. Each of those stops is a `<g>` with
         * no visible focus style — React Flow's own stylesheet sets
         * `outline: none` on it — announced as "Edge from <uuid> to <uuid>".
         * A keyboard reader would give up long before reaching a person, and
         * that is the criterion this ticket exists for.
         *
         * Turning it off costs nothing here, because there is nothing an edge
         * *does*: it cannot be selected, reconnected or deleted on this
         * canvas, and what it means is said in words by the detail panel the
         * node opens. `lib/tree-layout.ts` finishes the job by hiding the
         * edges from assistive technology outright — see `EDGE_A11Y`, which
         * is only safe because of this line.
         */
        edgesFocusable={false}
        onNodesChange={onNodesChange}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {/*
        The other end of the link above: the first thing past the people.
        `tabIndex={-1}` is what makes it a place focus can be *put* without
        making it a place Tab stops, so a reader who ignores the link walks the
        generations exactly as `YEO-69` left them.

        It carries a line of text rather than being an empty box, because a
        reader who cannot see the canvas is owed confirmation that the jump
        happened — an unlabelled div announces nothing at all on arrival.
      */}
      <div id={TREE_SKIP_TARGET_ID} tabIndex={-1} className="sr-only">
        End of the family tree
      </div>

      {/*
        People on the canvas and nothing joining them (E3-T9). Hidden while a
        panel is open, because the panel is both the answer to the hint and,
        on a narrow viewport, sitting on top of it.
      */}
      {onboarding.stage === "unconnected" && detail === null ? (
        <TreeStartHint person={onboarding.person} />
      ) : null}

      {/*
        What a dashed line means (E10-T5), in the same corner and hidden under
        an open panel for the same two reasons. It cannot collide with the
        hint above: the hint is the stage where no union joins anybody, and
        every row of the key needs a union to exist. See `TreeLegend`.
      */}
      {detail === null ? <TreeLegend entries={legend} /> : null}

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
          onEditUnion={updateUnionAction ? setEditingUnionId : undefined}
          onAddChild={
            addChildAction ? () => setAddingChildFor(detail.id) : undefined
          }
          onSetParents={
            setParentsAction ? () => setSettingParentsFor(detail.id) : undefined
          }
        />
      )}

      {/*
        The correction dialogue, a sibling of the panel rather than something
        the panel renders. It is a modal over the whole canvas — the same
        surface `EditPerson` opens — and the panel is deliberately a read-only
        record that offers routes in rather than growing forms (see
        `components/PersonPanel.tsx`).

        Rendered outside the three-way branch above, so that opening it does
        not replace the record the author is correcting *from*: the union's
        dates stay legible behind the backdrop, which is what the author is
        checking their correction against.

        `editingUnion` is looked up from the graph on every render, so a
        revalidation that removes the union — a partner detached, two unions
        merged, in this tab or another — takes this dialogue with it rather
        than leaving a form open over a row that has gone. `detail` is required
        for the same reason `addingSpouseFor` is compared against `selectedId`:
        a dialogue is about the record it was opened from, and closing that
        record closes it.
      */}
      {detail && editingUnion && updateUnionAction ? (
        <EditUnionForm
          /*
            A different union is a different record to correct, so the form
            starts over rather than carrying one union's half-finished edits
            onto another.
          */
          key={editingUnion.id}
          union={editingUnion}
          title={unionTitle(detail, editingUnion.id)}
          action={updateUnionAction}
          onClose={() => setEditingUnionId(null)}
          returnFocus={returnFocusToEditButton}
        />
      ) : null}
    </div>
  );
}

/**
 * How the correction dialogue names the union it is about: "Rose and Walter",
 * or "Rose and an unrecorded partner".
 *
 * Built from the detail the panel is already showing rather than from the
 * graph, because the panel is what the author is looking at — the names in the
 * heading are the names in the list they clicked. A union that has somehow
 * left the list falls back to the person whose panel this is, which is the one
 * name that is certainly still true.
 */
function unionTitle(detail: PersonDetail, unionId: string): string {
  const spouse = detail.spouses.find((link) => link.unionId === unionId);
  if (!spouse) return `${detail.name}'s union`;
  return `${detail.name} and ${spouse.person?.name ?? "an unrecorded partner"}`;
}
