"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import { mergeUnionsAction } from "@/app/tree/actions";
import { ModalDialog } from "@/components/ModalDialog";
import type { ChildRelation } from "@/lib/child-input";
import type { FamilyGraph, GraphUnion } from "@/lib/family-graph";
import { idleUnionMergeState } from "@/lib/merge-state";
import type { PersonSummary } from "@/lib/person-detail";
import {
  describeUnionFacts,
  type DuplicateUnionGroup,
  duplicateUnionGroups,
  previewUnionMerge,
  type UnionFactLoss,
  type UnionFacts,
  type UnionMergePreview,
  unionFacts,
} from "@/lib/union-merge";

/**
 * Merging two families recorded between the same two people (E3-T10,
 * `YEO-82`).
 *
 * ## Why this exists at all
 *
 * `lib/set-parents.ts` can create a family inline, and until this ticket it did
 * so without asking whether those two people already had one — so a tree can
 * be holding a marriage and a bare `unknown` union between the same pair, with
 * the children divided between them. The prompt in `SetParentsForm` stops new
 * ones appearing. This is the other half: the ones already there.
 *
 * ## Why it is a prompt rather than a rule
 *
 * Because two families between the same two people is *not* automatically an
 * error. A couple who divorced and remarried each other is ordinary genealogy
 * and the tree has to go on expressing it, which is why nothing here ever
 * merges anything on its own and why the section is worded as a question. An
 * author who reads it and closes the dialogue has given a real answer.
 *
 * ## Why the confirmation is written the way it is
 *
 * The same reason E3-T8's is (`components/PersonRemoval.tsx`): there is no
 * revision history under the tree, so nothing here is undoable and the copy is
 * the entire safety mechanism. Every sentence in the second stage comes from
 * `lib/union-merge.ts`, which reads the real rows — so it names the actual
 * children who move, the actual values that will stop being recorded, and the
 * actual place the surviving family takes in both partners' order.
 *
 * ## Why it is a component of its own
 *
 * `components/PersonPanel.tsx` renders it through the same footer slot
 * `PersonRemoval` arrives by, and knows nothing about it. That keeps the panel
 * a read-only record and keeps this ticket's diff off a file several sibling
 * tickets are editing.
 */
export function UnionMerge({
  graph,
  personId,
}: {
  graph: FamilyGraph;
  /** The person whose panel this is. Every family offered is one of theirs. */
  personId: string;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<MergeChoice | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // One pass over the graph, and only when the graph or the person changes.
  // The panel re-renders on every selection and every keystroke elsewhere on
  // the canvas; none of that needs the families regrouped.
  const groups = useMemo(
    () => duplicateUnionGroups(graph, personId),
    [graph, personId],
  );

  /**
   * Nothing recorded twice and nothing on screen: almost everybody. A heading
   * over an empty list would be inventing a problem to look at.
   *
   * `&& !open` is the part that is not obvious, and it is there because a
   * successful merge *empties this list from under itself*. The action
   * revalidates `/tree`, a graph arrives in which the two records are one, and
   * this person's only duplicate group is gone — so an unconditional early
   * return would unmount the section, the trigger and the open dialogue
   * together, taking the confirmation's own "Merged." away before anybody read
   * it. Nobody asked for that, and the dialogue is the only thing that ever
   * says what happened.
   *
   * `components/PersonRemoval.tsx` gets away with the unconditional form
   * because the write it confirms deletes the person, which closes the panel
   * this whole section lives in — there is no surface left to report onto. A
   * merge deletes nobody, so the panel stays exactly where it was.
   */
  if (groups.length === 0 && !open) return null;

  function close() {
    setOpen(false);
    setChoice(null);
  }

  /**
   * Focus goes back to the button that opened it (`YEO-83`), which is what
   * `components/PersonRemoval.tsx` does and for the same reason: without it a
   * keyboard user dismisses the dialogue and lands on `<body>`, behind the
   * panel they were reading.
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
      <p className="text-note text-ink-muted">
        {groups.length === 1
          ? "Two records of the same family?"
          : "Families recorded more than once?"}
      </p>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
      >
        Merge duplicate families…
      </button>

      {open ? (
        <ModalDialog
          title={
            choice === null
              ? "Merge two records of one family"
              : "Check this first"
          }
          onClose={close}
          returnFocus={returnFocus}
        >
          {choice === null ? (
            groups.length === 0 ? (
              /*
                The list this dialogue was opened on has emptied under it.

                Not reached by closing a successful merge — that button clears
                `choice` and `open` together, so the guard above unmounts the
                whole section first. What reaches it is **Back**, which clears
                only `choice`: a confirmation whose pair went in another tab
                shows the "no longer both recorded" fallback, and backing out
                of that lands here when it was the last duplicate group.

                Said plainly rather than rendered as an empty list under a
                heading.
              */
              <>
                <p className="text-caption">
                  Nothing is recorded twice any more.
                </p>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <MergeChoices groups={groups} onChoose={setChoice} />
            )
          ) : (
            <MergeConfirmation
              // Remounts when the author backs out and picks a different
              // direction, so a failure reported for one merge cannot linger
              // on the next one's dialogue.
              key={`${choice.keepUnionId}-${choice.mergeUnionId}`}
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

/** Which merge the author picked, as a reference to the rows it touches. */
type MergeChoice = { keepUnionId: string; mergeUnionId: string };

/**
 * The first stage: which pair, and — the question that decides everything —
 * which of the two survives.
 *
 * Every ordered pair is offered rather than a pair plus a swap control,
 * because the direction *is* the choice: the surviving row keeps its own type,
 * dates and end reason, so "keep this one" and "keep that one" are two
 * different outcomes and both deserve to be visible at once. A group of three
 * duplicates yields six buttons and is expected to be merged twice; the
 * alternative — a hidden toggle — hides the only decision there is.
 */
function MergeChoices({
  groups,
  onChoose,
}: {
  groups: readonly DuplicateUnionGroup[];
  onChoose: (choice: MergeChoice) => void;
}) {
  return (
    <>
      <p className="text-caption">
        These are recorded as separate families. Merging keeps one record and
        moves everything from the other into it.
      </p>
      <p className="text-note text-ink-muted">
        Leave them as they are if the two people really did marry more than
        once. That is a record, not a mistake.
      </p>

      {groups.map((group) => (
        <section key={group.partner.id} className="mt-3">
          <h3 className="text-note text-ink-muted">
            {group.unions.length} families recorded with {group.partner.name}
          </h3>
          <ul className="space-y-2">
            {orderedPairs(group.unions).map(([keep, merge]) => (
              <li key={`${keep.id}-${merge.id}`}>
                <button
                  type="button"
                  onClick={() =>
                    onChoose({ keepUnionId: keep.id, mergeUnionId: merge.id })
                  }
                  className="mt-1 block w-full rounded-panel border border-rule px-3 py-2 text-left hover:bg-wash"
                >
                  <span className="text-caption">
                    Keep {describeUnionFacts(unionFacts(keep))}
                  </span>
                  <span className="block text-note text-ink-muted">
                    Merge {describeUnionFacts(unionFacts(merge))} into it
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * Every ordered pair of a group's unions: which to keep, and which to merge in.
 *
 * Ordered rather than combinations, because the two directions are different
 * operations — see `MergeChoices`.
 */
function orderedPairs(
  unions: readonly GraphUnion[],
): [GraphUnion, GraphUnion][] {
  const pairs: [GraphUnion, GraphUnion][] = [];
  for (const keep of unions) {
    for (const merge of unions) {
      if (keep.id !== merge.id) pairs.push([keep, merge]);
    }
  }
  return pairs;
}

/**
 * The second stage: exactly what this merge does, and the button that does it.
 *
 * The preview is recomputed here rather than passed down from the first stage,
 * so what is shown derives from the same graph the confirm button is about to
 * act on. It can come back null — the rows may have gone in another tab — and
 * that is the one case where there is nothing to confirm.
 */
function MergeConfirmation({
  graph,
  choice,
  onBack,
  onCancel,
}: {
  graph: FamilyGraph;
  choice: MergeChoice;
  onBack: () => void;
  onCancel: () => void;
}) {
  const preview = useMemo(
    () => previewUnionMerge(graph, choice.keepUnionId, choice.mergeUnionId),
    [graph, choice],
  );

  const [state, formAction, pending] = useActionState(
    mergeUnionsAction,
    idleUnionMergeState,
  );

  /**
   * What just happened, checked *before* the preview — which is the whole
   * reason this branch is a branch rather than a line inside the form.
   *
   * A merge that succeeds revalidates `/tree`, and the graph that arrives no
   * longer holds the record that was merged away. `previewUnionMerge` then
   * returns null, correctly and by design: one of the two unions is missing.
   * Reading that as the "these rows have gone, somebody else may have removed
   * them" case would replace the author's own success with a sentence about a
   * race they did not have — the merge they are being warned about is the one
   * they just performed.
   *
   * So the order is: what this dialogue did, then what the graph says. Only
   * the second is a guess about somebody else.
   */
  if (state.status === "merged") {
    return (
      <>
        {/*
          `role="alert"` because this replaces the confirmation the author was
          reading, after a submission they are watching for.
        */}
        <p role="alert" className="text-caption">
          Merged. The two records are one, and nothing recorded on either of
          them was lost.
        </p>
        <div className="mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
          >
            Close
          </button>
        </div>
      </>
    );
  }

  if (preview === null) {
    return (
      <>
        <p className="text-caption">
          Those two families are no longer both recorded. One of them may
          already have been removed.
        </p>
        <DialogButtons onBack={onBack} onCancel={onCancel} />
      </>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="keepUnionId" value={preview.kept.unionId} />
      <input type="hidden" name="mergeUnionId" value={preview.merged.unionId} />

      <MergeCopy preview={preview} />

      {state.status === "failed" ? (
        // `role="alert"` because this appears after a submission the author is
        // watching for, and it is the only thing on screen that changed.
        <p role="alert" className="mt-3 text-caption">
          {state.error}
        </p>
      ) : null}
      <DialogButtons onBack={onBack} onCancel={onCancel}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash disabled:opacity-60"
        >
          {pending ? "Merging…" : "Merge"}
        </button>
      </DialogButtons>
    </form>
  );
}

/**
 * What a merge actually does, said in full.
 *
 * The list of losses is the sentence this whole dialogue exists for. Which
 * `type`, dates and end reason survive is decided by *which record is kept* —
 * see `UnionFactLoss` for why that is the choice rather than a field-by-field
 * picker — so an author who is about to lose the marriage date has to be able
 * to read it here and turn the merge around.
 */
function MergeCopy({ preview }: { preview: UnionMergePreview }) {
  const partners = joinNames(preview.partners);

  return (
    <>
      <p className="text-caption">
        Merge two records of <Name>{partners}</Name> into one?
      </p>
      <p className="text-note text-ink-muted">
        The tree keeps no history, so this cannot be undone.
      </p>

      <h4 className="mt-3 text-note text-ink-muted">This will change</h4>
      <ul className="space-y-1 text-caption">
        <li>
          The record kept is {describeUnionFacts(preview.kept)}. The other
          record goes.
        </li>

        {preview.moving.length > 0 ? (
          <li>
            {joinNames(preview.moving.map((entry) => entry.child))}{" "}
            {preview.moving.length === 1 ? "is" : "are"} recorded in the family
            you keep instead.
            <span className="block text-note text-ink-muted">
              Nobody loses a parent: the same two people are recorded either
              way.
            </span>
          </li>
        ) : null}

        {preview.shared.map((entry) => (
          <li key={entry.child.id}>
            {entry.child.name} is recorded in both. The duplicate link goes.
            {entry.keptRelation === entry.mergedRelation ? null : (
              <span className="block text-note text-ink-muted">
                Recorded as{" "}
                {RELATION_LABELS[entry.mergedRelation].toLowerCase()} on the
                record going, and{" "}
                {RELATION_LABELS[entry.keptRelation].toLowerCase()} on the one
                you keep. The one you keep stands.
              </span>
            )}
          </li>
        ))}

        {preview.losses.map((loss) => {
          const { losing, keeping } = describeLoss(loss);
          return (
            <li key={loss.field}>
              The record going says {FIELD_LABELS[loss.field]}: {losing}.{" "}
              {keeping === null
                ? "The one you keep does not say, and will not afterwards."
                : `The one you keep says ${keeping}, and that is what stays.`}
            </li>
          );
        })}

        {preview.resequences ? (
          <li>
            The family you keep moves to the earlier of the two places in the
            order of {partners}&rsquo;s families.
          </li>
        ) : null}
      </ul>

      <h4 className="mt-3 text-note text-ink-muted">This will keep</h4>
      <ul className="space-y-1 text-caption">
        <li>Everybody. Nobody is deleted, and no child link is lost.</li>
        <li>
          Notes from both records, kept together on the one that survives.
        </li>
      </ul>
    </>
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

const UNION_TYPE_LABELS: Record<UnionFacts["type"], string> = {
  marriage: "Marriage",
  partnership: "Partnership",
  unknown: "Union, type not recorded",
};

const END_REASON_LABELS: Record<UnionFacts["endReason"], string> = {
  ongoing: "It did not end",
  death: "Ended by death",
  divorce: "Divorce",
  separation: "Separation",
  unknown: "Ended, reason unknown",
};

const RELATION_LABELS: Record<ChildRelation, string> = {
  biological: "Biological",
  adopted: "Adopted",
  step: "Step",
  foster: "Foster",
};

const FIELD_LABELS: Record<UnionFactLoss["field"], string> = {
  type: "what kind of union it was",
  start: "when it began",
  end: "when it ended",
  endReason: "how it ended",
};

/**
 * The two sides of one loss, in the words the rest of the application uses.
 *
 * A `switch` over the field rather than a lookup by name, because
 * `UnionFactLoss` is a discriminated union: narrowing on `field` is what makes
 * each label map exhaustive over the enum it belongs to, with no cast standing
 * where a wrong `endReason` would otherwise go unnoticed. The dates need no
 * translation — `lib/format-date.ts` has already qualified and formatted them.
 */
function describeLoss(loss: UnionFactLoss): {
  losing: string;
  keeping: string | null;
} {
  switch (loss.field) {
    case "type":
      return {
        losing: UNION_TYPE_LABELS[loss.losing],
        keeping: loss.keeping === null ? null : UNION_TYPE_LABELS[loss.keeping],
      };
    case "endReason":
      return {
        losing: END_REASON_LABELS[loss.losing],
        keeping: loss.keeping === null ? null : END_REASON_LABELS[loss.keeping],
      };
    default:
      return { losing: loss.losing, keeping: loss.keeping };
  }
}

/** "Alice", "Alice and Brian", "Alice, Brian and Clara". */
function joinNames(people: readonly PersonSummary[]): string {
  const names = people.map((person) => person.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
