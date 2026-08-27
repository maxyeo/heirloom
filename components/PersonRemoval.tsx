"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import {
  detachChildAction,
  detachPartnerAction,
  removePersonAction,
} from "@/app/tree/actions";
import { ModalDialog } from "@/components/ModalDialog";
import type { FamilyGraph } from "@/lib/family-graph";
import type { PersonSummary } from "@/lib/person-detail";
import {
  type ChildDetachmentPreview,
  type PartnerDetachmentPreview,
  type PersonRemovalPreview,
  previewChildDetachment,
  previewPartnerDetachment,
  previewPersonRemoval,
  type UnionRemoval,
} from "@/lib/removal-preview";
import { idleRemovalState, type RemovalState } from "@/lib/removal-state";

/**
 * Removing somebody, or just a relationship, from the tree (E3-T8, `YEO-36`).
 *
 * ## Why the gentle options come first
 *
 * Most of the time, "delete this person" is not what the author means. They
 * mean *he was not her husband*, or *that is not their child* — a correction
 * to one link, made by somebody who is about to reach for the only button
 * they can see. Deleting the person to fix a wrong marriage would be
 * catastrophically more than they asked for, because `db/schema.ts` cascades
 * from `individuals` to the whole union row and takes the surviving partner's
 * link to every child of that union with it.
 *
 * So this opens on a list of the *narrow* removals — one partner out of one
 * union, one child out of one union — with deleting the person set apart at
 * the bottom as its own, differently-styled thing. The acceptance criterion
 * asks for detaching to be "a separate, gentler action than deleting a
 * person"; putting them side by side, in that order, is what makes the gentle
 * one the obvious one.
 *
 * ## Why the second stage exists
 *
 * Because the confirmation copy is the entire safety mechanism. There is no
 * revision history under the tree the way there is under entries (see
 * `lib/save-individual.ts`), so nothing here is undoable, and a dialogue that
 * said "are you sure?" would be worth nothing at all. Every sentence in the
 * second stage is generated from `lib/removal-preview.ts`, which reads the
 * real `unions` and `union_children` rows — so it names the actual partner,
 * the actual children, and the actual consequence for each of them.
 *
 * ## Why this is a component of its own
 *
 * `components/PersonPanel.tsx` renders it through a slot and knows nothing
 * about it. That keeps the panel a read-only record — its whole design (see
 * its own note) — and it keeps this ticket's diff off a file that E3-T2 and
 * E3-T4 are editing at the same time.
 */
export function PersonRemoval({
  graph,
  personId,
}: {
  graph: FamilyGraph;
  /** The person whose panel this is. Every removal offered is one of theirs. */
  personId: string;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // One pass over the graph, and only when the graph or the person changes.
  // The panel re-renders on every selection and on every keystroke elsewhere
  // on the canvas; this does not need to walk the tree again for any of that.
  const preview = useMemo(
    () => previewPersonRemoval(graph, personId),
    [graph, personId],
  );

  // The person left the graph under us — deleted here, or in another tab and
  // revalidated into this one. There is nothing left to remove.
  if (preview === null) return null;

  /**
   * Dismissing the dialogue, from any of its four exits — Cancel, Escape, the
   * backdrop, or the close of a stage that had nothing to confirm.
   *
   * Where focus goes afterwards is deliberately *not* decided here (`YEO-83`).
   * It used to be, and a callback only ever covers the exits routed through
   * it: a removal that succeeds takes this dialogue away through its own form
   * and never calls this at all. `returnFocus` below hangs the restore on the
   * dialogue *leaving* instead, which is the one thing every exit has in
   * common. In that last case the trigger has gone too — the person is out of
   * the graph and this section renders nothing — and the hook declines to
   * focus an element that is no longer connected, which is the honest answer
   * rather than a special case written out here.
   */
  function close() {
    setOpen(false);
    setChoice(null);
  }

  /**
   * Focus goes back to the button that opened it, which is the pattern
   * `components/PersonPanel.tsx` sets for itself ("the caller knows which DOM
   * node that is"). Without it a keyboard user dismisses the dialogue and
   * lands on `<body>`, behind the very panel they were reading, with no way
   * back but tabbing in from the top of the document.
   *
   * The trigger is always mounted — it sits behind the overlay rather than
   * being replaced by it — so there is nothing to wait for here.
   */
  const returnFocus = () => triggerRef.current;

  return (
    <section
      /*
        `py-3` for the reason `components/EditPersonForm.tsx` gives at its own
        `<section>`: the trailing padding is what keeps the next section's rule
        off an inline-block button that hangs below its line box.
      */
      className="border-t border-rule-soft py-3"
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
      >
        Remove…
      </button>

      {open ? (
        <ModalDialog
          title={
            choice === null
              ? `Remove something about ${preview.person.name}`
              : "Check this first"
          }
          onClose={close}
          returnFocus={returnFocus}
        >
          {choice === null ? (
            <RemovalChoices preview={preview} onChoose={setChoice} />
          ) : (
            <RemovalConfirmation
              // Remounts when the author backs out and picks something else,
              // so a failure reported for one removal cannot linger on the
              // next one's dialogue.
              key={choiceKey(choice)}
              graph={graph}
              choice={choice}
              onBack={() => setChoice(null)}
              onCancel={close}
            />
          )}
        </ModalDialog>
      ) : null}
    </section>
  );
}

/** Which removal the author picked, as a reference to the rows it touches. */
type Choice =
  | { kind: "person"; personId: string }
  | { kind: "partner"; unionId: string; personId: string }
  | { kind: "child"; unionId: string; childId: string };

function choiceKey(choice: Choice): string {
  return choice.kind === "person"
    ? `person-${choice.personId}`
    : choice.kind === "partner"
      ? `partner-${choice.unionId}-${choice.personId}`
      : `child-${choice.unionId}-${choice.childId}`;
}

/**
 * The first stage: everything that can be removed from here, narrowest first.
 *
 * Built from the person-deletion preview rather than from a second pass over
 * the graph, because that value already holds exactly the right list — the
 * unions this person is a partner in, the children hanging off each of them,
 * and the union recording who their own parents were. Those are the three
 * things there are to detach.
 */
function RemovalChoices({
  preview,
  onChoose,
}: {
  preview: PersonRemovalPreview;
  onChoose: (choice: Choice) => void;
}) {
  const nothingToDetach =
    preview.unions.length === 0 && preview.parentLinks.length === 0;

  return (
    <>
      <h3 className="text-note text-ink-muted">Detach a relationship</h3>
      <p className="text-caption">
        Nobody is deleted. Only the link goes, and it can be recorded again.
      </p>

      {nothingToDetach ? (
        <p className="text-caption text-ink-muted">
          {preview.person.name} has no recorded relationships to detach.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {preview.unions.map((union) => (
            <li key={union.unionId}>
              <ChoiceButton
                onClick={() =>
                  onChoose({
                    kind: "partner",
                    unionId: union.unionId,
                    personId: preview.person.id,
                  })
                }
                label={`${preview.person.name} and ${union.partner?.name ?? "an unrecorded partner"} were not partners`}
                note={describeUnion(union)}
              />

              {union.children.map((child) => (
                <ChoiceButton
                  key={child.id}
                  onClick={() =>
                    onChoose({
                      kind: "child",
                      unionId: union.unionId,
                      childId: child.id,
                    })
                  }
                  label={`${child.name} is not their child`}
                  note={`Recorded in this ${UNION_NOUN[union.type].toLowerCase()}`}
                />
              ))}
            </li>
          ))}

          {preview.parentLinks.map((link) => (
            <li key={link.unionId}>
              <ChoiceButton
                onClick={() =>
                  onChoose({
                    kind: "child",
                    unionId: link.unionId,
                    childId: preview.person.id,
                  })
                }
                label={`${preview.person.name} is not their child`}
                note={
                  link.parents.length === 0
                    ? "Recorded as a child of a union with no partners named"
                    : `Currently recorded as a child of ${joinNames(link.parents)}`
                }
              />
            </li>
          ))}
        </ul>
      )}

      {/*
        Set apart, and last. This is the only irreversible option in the
        dialogue, and the visual break is doing the same job the ordering is:
        making it something you arrive at deliberately rather than something
        your eye lands on first.
      */}
      <h3 className="mt-4 border-t border-rule pt-3 text-note text-ink-muted">
        Delete the person
      </h3>
      <ChoiceButton
        onClick={() =>
          onChoose({ kind: "person", personId: preview.person.id })
        }
        label={`Delete ${preview.person.name} from the tree`}
        note="Removes their record and every relationship recorded with it"
        destructive
      />
    </>
  );
}

function ChoiceButton({
  onClick,
  label,
  note,
  destructive = false,
}: {
  onClick: () => void;
  label: string;
  note: string;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-1 block w-full rounded-panel border px-3 py-2 text-left hover:bg-wash ${
        destructive ? "border-rule bg-wash" : "border-rule"
      }`}
    >
      <span className="text-caption">{label}</span>
      <span className="block text-note text-ink-muted">{note}</span>
    </button>
  );
}

/**
 * The second stage: exactly what this removal takes, and the button that
 * takes it.
 *
 * The preview is recomputed here rather than passed down from the first
 * stage, so that what is shown is derived from the same graph the confirm
 * button is about to act on. It can still come back null — the rows may have
 * gone in another tab — and that is the one case where there is nothing to
 * confirm.
 */
function RemovalConfirmation({
  graph,
  choice,
  onBack,
  onCancel,
}: {
  graph: FamilyGraph;
  choice: Choice;
  onBack: () => void;
  onCancel: () => void;
}) {
  const preview = useMemo(
    () =>
      choice.kind === "person"
        ? previewPersonRemoval(graph, choice.personId)
        : choice.kind === "partner"
          ? previewPartnerDetachment(graph, choice.unionId, choice.personId)
          : previewChildDetachment(graph, choice.unionId, choice.childId),
    [graph, choice],
  );

  if (preview === null) {
    return (
      <>
        <p className="text-caption">
          That is no longer recorded in the tree. It may already have been
          removed.
        </p>
        <DialogButtons onBack={onBack} onCancel={onCancel} />
      </>
    );
  }

  if (preview.kind === "person") {
    return (
      <RemovalForm
        action={removePersonAction}
        fields={{ personId: preview.person.id }}
        confirmLabel={`Delete ${preview.person.name}`}
        destructive
        onBack={onBack}
        onCancel={onCancel}
      >
        <PersonRemovalCopy preview={preview} />
      </RemovalForm>
    );
  }

  if (preview.kind === "partner") {
    return (
      <RemovalForm
        action={detachPartnerAction}
        fields={{ unionId: preview.unionId, personId: preview.person.id }}
        confirmLabel="Detach"
        onBack={onBack}
        onCancel={onCancel}
      >
        <PartnerDetachmentCopy preview={preview} />
      </RemovalForm>
    );
  }

  return (
    <RemovalForm
      action={detachChildAction}
      fields={{ unionId: preview.unionId, childId: preview.child.id }}
      confirmLabel="Detach"
      onBack={onBack}
      onCancel={onCancel}
    >
      <ChildDetachmentCopy preview={preview} />
    </RemovalForm>
  );
}

/**
 * What deleting a person actually does, said in full.
 *
 * The second bullet of each union is the sentence this whole ticket exists
 * for. Deleting somebody does not remove them from their marriage — it
 * removes the marriage, so the *other* partner stops being recorded as a
 * parent of children who are still in the tree. Nobody predicts that from a
 * delete button, and nothing in the tree can restore it afterwards.
 */
function PersonRemovalCopy({ preview }: { preview: PersonRemovalPreview }) {
  return (
    <>
      <p className="text-caption">
        Delete <Name>{preview.person.name}</Name>
        {preview.person.lifespan ? ` (${preview.person.lifespan})` : null} from
        the tree?
      </p>
      <p className="text-note text-ink-muted">
        The tree keeps no history, so this cannot be undone.
      </p>

      <h4 className="mt-3 text-note text-ink-muted">This will delete</h4>
      <ul className="space-y-1 text-caption">
        <li>Their record: name, dates, places and notes.</li>

        {preview.unions.map((union) => (
          <li key={union.unionId}>
            {describeUnion(union)}
            {union.children.length > 0 ? (
              <span className="block text-note text-ink-muted">
                {union.partner
                  ? `${union.partner.name} stops being recorded as a parent of ${joinNames(union.children)}.`
                  : `${joinNames(union.children)} stop being recorded as belonging to this union.`}
              </span>
            ) : null}
          </li>
        ))}

        {preview.parentLinks.map((link) => (
          <li key={link.unionId}>
            {link.parents.length === 0
              ? "Their place as a child of a union with no partners named."
              : `Their place as a child of ${joinNames(link.parents)}.`}
          </li>
        ))}

        {preview.orphanedUnionIds.length > 0 ? (
          <li>
            {preview.orphanedUnionIds.length === 1
              ? "A union record that would be left with nobody in it — no partners and no children."
              : "Union records that would be left with nobody in them — no partners and no children."}
          </li>
        ) : null}
      </ul>

      <h4 className="mt-3 text-note text-ink-muted">This will keep</h4>
      <ul className="space-y-1 text-caption">
        {preview.survivors.length > 0 ? (
          <li>
            {joinNames(preview.survivors)}{" "}
            {preview.survivors.length === 1 ? "stays" : "stay"} in the tree.
            Only the links above go.
          </li>
        ) : (
          <li>Nobody else is recorded with them, so nobody else is touched.</li>
        )}
        {preview.keepsEntry ? (
          <li>
            Their wiki entry, and all of its revisions. It simply stops being
            linked to anybody.
          </li>
        ) : null}
      </ul>
    </>
  );
}

function PartnerDetachmentCopy({
  preview,
}: {
  preview: PartnerDetachmentPreview;
}) {
  return (
    <>
      <p className="text-caption">
        Record that <Name>{preview.person.name}</Name> and{" "}
        <Name>{preview.partner?.name ?? "the unrecorded partner"}</Name> were
        not partners?
      </p>

      <h4 className="mt-3 text-note text-ink-muted">This will change</h4>
      <ul className="space-y-1 text-caption">
        <li>
          {preview.partner
            ? `The ${UNION_NOUN[preview.type].toLowerCase()} between them is no longer recorded.`
            : "This union no longer records them as a partner."}
        </li>
        {preview.children.length > 0 ? (
          <li>
            {joinNames(preview.children)}{" "}
            {preview.children.length === 1 ? "stops" : "stop"} being recorded as{" "}
            {preview.person.name}&rsquo;s{" "}
            {preview.children.length === 1 ? "child" : "children"}.
            {preview.partner ? (
              <span className="block text-note text-ink-muted">
                They keep {preview.partner.name} as a parent, and stay in the
                tree.
              </span>
            ) : null}
          </li>
        ) : null}
        {preview.removesUnion ? (
          <li>
            The union record itself goes, because nobody at all would be left in
            it — no partners and no children.
          </li>
        ) : null}
      </ul>

      <h4 className="mt-3 text-note text-ink-muted">This will keep</h4>
      <ul className="space-y-1 text-caption">
        <li>
          Both people, their records and their wiki entries. Nobody is deleted.
        </li>
      </ul>
    </>
  );
}

function ChildDetachmentCopy({ preview }: { preview: ChildDetachmentPreview }) {
  return (
    <>
      <p className="text-caption">
        Record that <Name>{preview.child.name}</Name> is not{" "}
        {preview.parents.length === 0
          ? "a child of this union"
          : `${joinNames(preview.parents)}${preview.parents.length === 1 ? "'s" : "'"} child`}
        ?
      </p>

      <h4 className="mt-3 text-note text-ink-muted">This will change</h4>
      <ul className="space-y-1 text-caption">
        <li>
          {preview.parents.length === 0
            ? `${preview.child.name} is no longer recorded in this union.`
            : `${preview.child.name} is no longer recorded as a child of ${joinNames(preview.parents)}.`}
          {preview.parents.length > 1 ? (
            /*
              Worth saying out loud, because the model makes it unavoidable
              and the dialogue would otherwise be over-promising. A child
              belongs to a *union*, never to a parent, so there is no half of
              this link to keep — detaching one parent is not something the
              data can express.
            */
            <span className="block text-note text-ink-muted">
              Both parents go together. Parenthood is recorded through the
              union, so there is no way to keep one of them.
            </span>
          ) : null}
        </li>
        {preview.removesUnion ? (
          <li>
            The union record itself goes, because nobody at all would be left in
            it — no partners and no children.
          </li>
        ) : null}
      </ul>

      <h4 className="mt-3 text-note text-ink-muted">This will keep</h4>
      <ul className="space-y-1 text-caption">
        <li>
          Everybody involved, their records and their wiki entries. Nobody is
          deleted.
        </li>
      </ul>
    </>
  );
}

/**
 * The form that actually submits one removal.
 *
 * The references travel as hidden fields and nothing else does — no names, no
 * dates, no copy. That is the split the Next.js server-actions guide asks for
 * (the client says *which*, never *what*), and it is why the action needs no
 * validation layer of its own: there is nothing to validate but the shape of
 * two ids, which `lib/remove-from-tree.ts` checks before it reaches Postgres.
 *
 * On success the action revalidates `/tree`, the page re-renders with a graph
 * this person is no longer in, and the canvas re-seeds — which unmounts the
 * panel and this dialogue with it. So the success branch below is a fallback
 * for the case where that has not happened yet, rather than the normal path.
 */
function RemovalForm({
  action,
  fields,
  confirmLabel,
  destructive = false,
  onBack,
  onCancel,
  children,
}: {
  action: (state: RemovalState, form: FormData) => Promise<RemovalState>;
  fields: Record<string, string>;
  confirmLabel: string;
  destructive?: boolean;
  onBack: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, idleRemovalState);

  return (
    <form action={formAction}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children}

      {state.status === "failed" ? (
        // `role="alert"` because this appears after a submission the author
        // is watching for, and it is the only thing on screen that changed.
        <p role="alert" className="mt-3 text-caption">
          {state.error}
        </p>
      ) : null}
      {state.status === "removed" ? (
        <p role="alert" className="mt-3 text-caption">
          Removed.
        </p>
      ) : null}

      <DialogButtons onBack={onBack} onCancel={onCancel}>
        <button
          type="submit"
          disabled={pending || state.status === "removed"}
          className={`rounded-panel border px-3 py-1 text-note disabled:opacity-60 ${
            destructive
              ? "border-rule bg-wash font-medium hover:bg-paper"
              : "border-rule hover:bg-wash"
          }`}
        >
          {pending ? "Working…" : confirmLabel}
        </button>
      </DialogButtons>
    </form>
  );
}

function DialogButtons({
  onBack,
  onCancel,
  children,
}: {
  onBack: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
      >
        Cancel
      </button>
      {children}
    </div>
  );
}

function Name({ children }: { children: React.ReactNode }) {
  return <strong className="font-medium">{children}</strong>;
}

const UNION_NOUN: Record<UnionRemoval["type"], string> = {
  marriage: "Marriage",
  partnership: "Partnership",
  unknown: "Union",
};

/**
 * A union as a phrase: "Marriage to Walter Doyle, 1946 – 1970."
 *
 * Assembled from the parts that are recorded rather than from a template with
 * gaps in it, exactly as `describeUnion` in the detail panel is — a union
 * with no dates still has a type and a partner, and "Marriage to Walter
 * Doyle." is a true sentence where "Marriage to Walter Doyle, – ." is not.
 */
function describeUnion(union: UnionRemoval): string {
  const span =
    union.start && union.end
      ? `${union.start} – ${union.end}`
      : union.start
        ? `from ${union.start}`
        : union.end
          ? `until ${union.end}`
          : null;

  const to = union.partner
    ? `to ${union.partner.name}`
    : "with no partner recorded";

  return `${[`${UNION_NOUN[union.type]} ${to}`, span].filter(Boolean).join(", ")}.`;
}

/** "Alice", "Alice and Brian", "Alice, Brian and Clara". */
function joinNames(people: readonly PersonSummary[]): string {
  const names = people.map((person) => person.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
