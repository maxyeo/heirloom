"use client";

import { useEffect, useRef, type Ref } from "react";

import { PersonPortrait } from "@/components/PersonPortrait";
import { useDismissableSurface } from "@/components/surface-stack";
import { usePersonRecordPanel } from "@/components/tree-panels";
import type {
  ChildLink,
  ParentLink,
  PersonDetail,
  PersonSummary,
  SpouseLink,
} from "@/lib/person-detail";

/**
 * The read-only detail panel for one person (E2-T1).
 *
 * ## What it is not
 *
 * It does no reasoning. `derivePersonDetail` turns the graph into the value
 * this renders, so "who are Rose's children" is answered and tested in a file
 * with no DOM in it, and the component below is a list of rows. Editing the
 * person is E3-T3 and the entry link is E2-T2 — the panel deliberately stops
 * at showing what is recorded, so that neither of those had to unpick a form
 * that was guessed at here first. Both arrived as slots (`footer`,
 * `entryLink`) rather than as forms this file learned to render.
 *
 * The one exception is `onAddSpouse` (E3-T4, `YEO-32`), and it is a *route in*
 * rather than a form: the add-spouse flow is about one person, so the only
 * place it can start is the panel that names them. The panel neither renders
 * that form nor knows what it contains — it renders a button when the canvas
 * gives it one, and the canvas decides what opening it means. Omit the prop
 * and the panel is exactly what it was.
 *
 * ## Where the dismissal logic lives
 *
 * The panel *declares itself dismissable* (`useDismissableSurface`, `YEO-83`)
 * and does not decide whether any particular Escape is for it. It used to: it
 * ran a `document` keydown listener of its own, and so did every other surface
 * on this canvas, which is how one keystroke closed the add-person panel and
 * the record behind it at once. The shared stack in
 * `components/surface-stack.ts` now owns that decision — the panel says what
 * dismissing means, and only the topmost surface is asked.
 *
 * "The panel closes on Escape" is still a property of the panel and still
 * testable as one; what has moved is who arbitrates between the surfaces that
 * all want the same key. The other two routes in remain the canvas's business:
 * React Flow deselects a node when the pane is clicked, and the tree turns
 * that into a close.
 */
export interface PersonPanelProps {
  detail: PersonDetail;
  /** Follow a relative's link. The panel stays open, showing them instead. */
  onSelectPerson: (personId: string) => void;
  onClose: () => void;
  /**
   * Rendered at the foot of the record, below everything the panel knows how
   * to say.
   *
   * A slot rather than a prop per feature, and it exists because the panel is
   * deliberately a *read-only* record (see the note above) while the things
   * that want to sit at the bottom of it are not. E3-T8 puts the remove and
   * detach affordance here, so that neither the cascade rules nor the
   * confirmation copy have to be understood by this file — the caller
   * composes `components/PersonRemoval.tsx` in and this renders it.
   */
  footer?: React.ReactNode;
  /**
   * Rendered under the dates and above the relatives: the person's wiki entry,
   * or the offer to write one (E2-T2).
   *
   * A slot rather than a prop per feature, for the reason `footer` gives — and
   * a *second* slot rather than more of the first, because this is not an edit
   * to the record. `components/PersonEntry.tsx` is what the canvas composes in
   * here; the panel neither knows what an entry is nor how one is started, and
   * omitting the prop leaves it exactly what it was.
   */
  entryLink?: React.ReactNode;
  /**
   * Start recording a marriage or partnership for this person (E3-T4).
   *
   * Optional, so the panel keeps working anywhere the flow is not offered —
   * and so this file did not have to grow a form to gain a button.
   */
  onAddSpouse?: () => void;
  /**
   * Correct one of the unions this person belongs to.
   *
   * The fourth of the same kind of prop as `onAddSpouse` — a route in, not a
   * form. It is per-row rather than one button at the foot of the panel
   * because the thing being corrected is *this* marriage: the author is
   * looking at the line that reads "Married, 1921" knowing it should say 1912,
   * and a footer control would ask them to name again the union they are
   * already pointing at. What the form contains, and that changing the partner
   * is not part of it, is the canvas's business rather than this file's.
   */
  onEditUnion?: (unionId: string) => void;
  /**
   * Start recording a child for this person (E3-T5).
   *
   * The same kind of prop as `onAddSpouse` and for the same reasons: a route
   * in, not a form. Which union the child belongs to is the add-child form's
   * question, not this panel's — the panel only knows whose record is open.
   */
  onAddChild?: () => void;
  /**
   * Start saying who this person's parents are (E3-T6).
   *
   * The third of the same kind of prop, and the one that answers "I added them
   * standalone and now want to connect them". Which family — chosen from the
   * tree, or created from two people who were never recorded as a couple — is
   * the set-parents form's question, and so is whether this is a correction to
   * a family they are already in. The panel only knows whose record is open.
   */
  onSetParents?: () => void;
  /**
   * Where focus goes when the panel leaves (`YEO-83`).
   *
   * A slot-shaped prop like `footer` and `entryLink`, and optional for the
   * same reason: the panel does not know which DOM node opened it, and the
   * canvas does — a React Flow node wrapper it has to find by scanning, which
   * is knowledge this file has no business holding. Called when the panel
   * unmounts, so every exit is covered rather than only the ones that go
   * through `onClose`; the guard against stealing focus from a reader who has
   * already moved on lives in the hook.
   *
   * Omit it and the panel closes exactly as it did, leaving focus wherever the
   * browser put it.
   */
  returnFocus?: () => HTMLElement | null;
  /** So the canvas can measure the panel and pan out from under it. */
  ref?: Ref<HTMLElement>;
}

export function PersonPanel({
  detail,
  onSelectPerson,
  onClose,
  footer,
  entryLink,
  onAddSpouse,
  onEditUnion,
  onAddChild,
  onSetParents,
  returnFocus,
  ref,
}: PersonPanelProps) {
  const headingRef = useRef<HTMLDivElement>(null);

  // Escape closes from wherever focus happens to be — on the node that opened
  // the panel, or on a link inside it. The shared listener is on the document
  // for that reason; a handler on the panel would only catch the second. Not
  // `modal`: the panel is part of the page and is deliberately tabbable past.
  /*
    `underneath` because this record can now open while the add-person panel
    is up — that panel is `z-20` to this one's `z-10` and wider, so it covers
    this completely, and an Escape over it must close it rather than something
    invisible behind it. See `withSurface` in `lib/surface-stack.ts`.
  */
  useDismissableSurface({ onDismiss: onClose, returnFocus, underneath: true });

  /**
   * And the right-hand column, which the add-person panel wants too: opening
   * that one closes this. Unconditionally, because this panel is a reading of
   * a row rather than a draft — there is nothing here that is not still in the
   * database, and one click on the node reopens it. See
   * `components/tree-panels.ts`.
   */
  usePersonRecordPanel(onClose);

  // Move focus into the panel when it opens, and again when it swaps to a
  // different person. Without this a keyboard user selects a node and their
  // focus is still on the canvas behind a panel they cannot reach; with it,
  // Tab walks the record and Escape puts them back where they started —
  // which is what makes "focus returns to the node" mean anything.
  useEffect(() => {
    headingRef.current?.focus();
  }, [detail.id]);

  return (
    <aside
      ref={ref}
      aria-label={`Details for ${detail.name}`}
      /*
        `fixed`, not `absolute`. Absolute resolved against the canvas wrapper
        in `FamilyTree`, and that wrapper starts below the tree page's own
        header — so the record stopped an `<h1>`, two lines of counts and a
        button short of the top of the screen, and left a band of empty paper
        beside them. Nothing between here and the viewport establishes a
        containing block (the shell transforms nothing), so `fixed` reaches
        past that wrapper to the box that actually matters: the viewport, less
        the sticky site header.

        `top-(--header-height)` is the same number `app/tree/page.tsx`
        subtracts to size its `main`, so the panel is exactly as tall as the
        page it belongs to and no taller. The site header keeps `z-40` against
        this `z-10`, so the panel passes under it rather than over it, and the
        page header's own button is moved out of the way in `page.tsx`.

        Below `sm` it stays the bottom sheet it always was. `max-h-[60%]` now
        measures against the viewport rather than the canvas, which makes the
        sheet a little taller on a phone — the right direction for a scrolling
        record, and it still leaves the tree the greater share.
      */
      className="fixed inset-x-0 bottom-0 z-10 flex max-h-[60%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:top-(--header-height) sm:right-0 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
        {/*
          `tabIndex={-1}` rather than a heading that is naturally focusable:
          the panel is not a modal dialog and should not trap anything, it
          just needs one place to put focus that reads out who this is.
        */}
        <div ref={headingRef} tabIndex={-1} className="min-w-0">
          <h2 className="truncate border-0 pb-0 text-h2">{detail.name}</h2>
          {detail.lifespan ? (
            <p className="text-caption text-ink-muted">{detail.lifespan}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/*
          The portrait (E5-T4, `YEO-44`), and the **full-resolution** one:
          this is the one place in the application somebody has asked to look
          at a particular person, and there is exactly one image on screen.
          The tree's thumbnail exists because a canvas draws hundreds at once,
          which is not this.

          Rendered only when there is one, unlike the tree node — and that
          asymmetry is deliberate rather than an oversight. A node reserves
          the box whether or not it is filled, because the layout must not
          move; the panel is ordinary flow, so nothing depends on its height,
          and a large empty silhouette on the majority of people who have no
          photograph would be noise offering something this read-only panel
          cannot do anything about.
        */}
        {detail.portraitSrc ? (
          <div className="mb-3">
            <PersonPortrait
              src={detail.portraitSrc}
              name={detail.name}
              size="panel"
            />
          </div>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
          <Fact term="Born" event={detail.birth} />
          <Fact term="Died" event={detail.death} />
          {detail.sex === "unknown" ? null : (
            <>
              <dt className="text-ink-muted">Sex</dt>
              <dd className="capitalize">{detail.sex}</dd>
            </>
          )}
        </dl>

        {entryLink}

        <Section title="Parents" count={detail.parents.length}>
          {detail.parents.map((parent) => (
            <ParentRow
              key={`${parent.unionId}-${parent.person.id}`}
              parent={parent}
              onSelectPerson={onSelectPerson}
            />
          ))}
        </Section>

        {/*
          Under the list, matching "Add a spouse" and "Add a child" below it,
          and offered whether or not parents are already recorded: correcting
          which family somebody belongs to is the same flow as naming one for
          the first time, and it is a move rather than a removal followed by an
          addition. The wording follows the list, because "Set parents" beside
          two names already on screen reads as though it would replace them.
        */}
        {onSetParents ? (
          <button
            type="button"
            onClick={onSetParents}
            className="mt-1 text-note text-link hover:underline"
          >
            {detail.parents.length === 0
              ? "Set parents"
              : "Change which family they belong to"}
          </button>
        ) : null}

        <Section
          title={detail.spouses.length === 1 ? "Spouse" : "Spouses"}
          count={detail.spouses.length}
        >
          {detail.spouses.map((spouse) => (
            <SpouseRow
              key={spouse.unionId}
              spouse={spouse}
              onSelectPerson={onSelectPerson}
              onEdit={
                onEditUnion ? () => onEditUnion(spouse.unionId) : undefined
              }
            />
          ))}
        </Section>

        {/*
          Under the list rather than in the header, because that is where the
          answer to "who else was there" is, and because a second marriage is
          added by looking at the first and finding it incomplete. Offered
          whether or not a spouse is already recorded: remarriage is the
          ordinary case this data model exists for, not an edge one.
        */}
        {onAddSpouse ? (
          <button
            type="button"
            onClick={onAddSpouse}
            className="mt-1 text-note text-link hover:underline"
          >
            Add a spouse
          </button>
        ) : null}

        <Section title="Children" count={detail.children.length}>
          {detail.children.map((child) => (
            <ChildRow
              key={`${child.unionId}-${child.person.id}`}
              child={child}
              onSelectPerson={onSelectPerson}
            />
          ))}
        </Section>

        {/*
          Under the list, matching "Add a spouse" above it. Offered whether or
          not the person has a union yet: which family a child belongs to is
          the form's question, and a panel that hid the button until a spouse
          existed would leave the author guessing why.
        */}
        {onAddChild ? (
          <button
            type="button"
            onClick={onAddChild}
            className="mt-1 text-note text-link hover:underline"
          >
            Add a child
          </button>
        ) : null}

        {detail.notes ? (
          <section>
            <h3>Notes</h3>
            {/*
              Plain text, rendered as text. `individuals.notes` is a `text`
              column that no editor and no sanitiser has ever been near — it is
              not a wiki body, and treating it like one would be the one place
              in the app where unsanitised markup reaches the browser.
              `whitespace-pre-line` keeps the line breaks somebody typed.
            */}
            <p className="text-caption whitespace-pre-line">{detail.notes}</p>
          </section>
        ) : null}

        {footer ? <div className="mt-4">{footer}</div> : null}
      </div>
    </aside>
  );
}

function Fact({ term, event }: { term: string; event: PersonDetail["birth"] }) {
  if (!event) return null;

  return (
    <>
      <dt className="text-ink-muted">{term}</dt>
      <dd>
        {event.date}
        {event.date && event.place ? ", " : null}
        {event.place}
      </dd>
    </>
  );
}

/**
 * A relatives list, or the honest statement that there is not one.
 *
 * "No children recorded" rather than an omitted heading, because the two mean
 * different things in genealogy and the difference is the whole point: an
 * absent section reads as "this panel does not show children", and what is
 * true is "nobody has entered any".
 */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {count === 0 ? (
        <p className="text-caption text-ink-muted">None recorded</p>
      ) : (
        <ul className="space-y-1">{children}</ul>
      )}
    </section>
  );
}

function ParentRow({
  parent,
  onSelectPerson,
}: {
  parent: ParentLink;
  onSelectPerson: (personId: string) => void;
}) {
  return (
    <li>
      <PersonLink person={parent.person} onSelectPerson={onSelectPerson} />
      {parent.relation === "biological" ? null : (
        <Qualifier text={parent.relation} />
      )}
    </li>
  );
}

function SpouseRow({
  spouse,
  onSelectPerson,
  onEdit,
}: {
  spouse: SpouseLink;
  onSelectPerson: (personId: string) => void;
  onEdit?: () => void;
}) {
  return (
    <li>
      {spouse.person ? (
        <PersonLink person={spouse.person} onSelectPerson={onSelectPerson} />
      ) : (
        // Both partner columns are nullable so that an unrecorded parent
        // never has to be invented as a placeholder person. Saying so is
        // more useful than dropping the union from the list.
        <span className="text-ink-muted">Unknown partner</span>
      )}
      {/*
        The date line and the way to correct it, on one row. The button is
        beside the sentence it edits rather than under it, so a person with
        three marriages gets three lines rather than six.
      */}
      <p className="flex items-baseline gap-2 text-note text-ink-muted">
        <span>{describeUnion(spouse)}</span>
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            /*
              How the canvas finds this button again when the dialogue it opens
              closes. The panel does not know a dialogue exists — it hands out
              a route in and nothing more — and the canvas does not know which
              row it came from, so the union's id is the one thing they both
              hold. The same shape as the node lookup that returns focus when
              the panel itself closes.
            */
            data-edit-union={spouse.unionId}
            /*
              Named for what it edits. "Edit" alone would be the fourth
              unqualified "Edit" on this panel and, read out of context by a
              screen reader moving through the spouse list, would not say which
              of three marriages it belongs to — `describeUnion` above is the
              only thing that distinguishes them, and it is not part of the
              button.
            */
            aria-label={`Edit this union with ${spouse.person?.name ?? "an unrecorded partner"}`}
            className="shrink-0 text-link hover:underline"
          >
            Edit
          </button>
        ) : null}
      </p>
    </li>
  );
}

function ChildRow({
  child,
  onSelectPerson,
}: {
  child: ChildLink;
  onSelectPerson: (personId: string) => void;
}) {
  return (
    <li>
      <PersonLink person={child.person} onSelectPerson={onSelectPerson} />
      {child.relation === "biological" ? null : (
        <Qualifier text={child.relation} />
      )}
      {/*
        Which union a child came through is what makes half-siblings legible:
        two children by Thomas and eight by Walter is a different family from
        ten children, and this line is the only thing that says which.
      */}
      <p className="text-note text-ink-muted">
        {child.otherParent
          ? `with ${child.otherParent.name}`
          : "other parent unknown"}
      </p>
    </li>
  );
}

/**
 * A relative, as something you can click to move the tree onto them.
 *
 * A button rather than an anchor, and deliberately: this changes which node is
 * selected on a canvas that is already open, and navigates nowhere. E2-T4 adds
 * `/tree?person=<id>`, and *that* is the ticket where these become real links
 * with an href worth copying.
 */
function PersonLink({
  person,
  onSelectPerson,
}: {
  person: PersonSummary;
  onSelectPerson: (personId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectPerson(person.id)}
      className="text-left text-link hover:underline"
    >
      {person.name}
      {person.lifespan ? (
        <span className="text-ink-muted"> ({person.lifespan})</span>
      ) : null}
    </button>
  );
}

function Qualifier({ text }: { text: string }) {
  return <span className="text-note text-ink-muted"> ({text})</span>;
}

const UNION_NOUN: Record<SpouseLink["type"], string> = {
  marriage: "Married",
  partnership: "Partnered",
  unknown: "Together",
};

const END_NOUN: Record<SpouseLink["endReason"], string> = {
  ongoing: "",
  death: "ended by death",
  divorce: "divorced",
  separation: "separated",
  unknown: "ended",
};

/**
 * One line for a union: when it began, when it ended, and why.
 *
 * Assembled from the parts that are actually recorded rather than from a
 * template with gaps in it — a union with no dates at all still has a type and
 * an end reason, and "Married, divorced" is a true and useful sentence where
 * "Married – " is neither.
 */
function describeUnion(spouse: SpouseLink): string {
  const span =
    spouse.start && spouse.end
      ? `${spouse.start} – ${spouse.end}`
      : // "until 1947" rather than a bare year, which on its own would read
        // as the date they married.
        (spouse.start ?? (spouse.end && `until ${spouse.end}`));

  return [UNION_NOUN[spouse.type], span, END_NOUN[spouse.endReason]]
    .filter(Boolean)
    .join(", ");
}
