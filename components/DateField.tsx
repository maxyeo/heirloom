"use client";

import { useId, useState } from "react";

import { parseDateInput } from "@/lib/parse-date";
import { formatQualifiedDate } from "@/lib/format-date";

/**
 * One date, as one text box (E4-T2, `YEO-39`).
 *
 * ## The rule this component exists to enforce
 *
 * **Never make a non-technical author pick a qualifier from a dropdown before
 * typing a date.** What it replaces is a `select` of four words the author has
 * to translate their source into — `exact` / `about` / `before` / `after` —
 * sitting in front of an `<input type="date">` that will only accept a
 * complete day. Somebody holding a census return that says "aged 40" has a
 * year and no month, and that pair of controls gave them two bad options:
 * pick a day nobody recorded, or type the truth into `notes` where nothing can
 * query it. They already know how to write "about 1890". This meets them
 * there.
 *
 * ## Where the work actually happens
 *
 * Almost nowhere in this file. `parseDateInput` turns the text into a date,
 * a qualifier and a precision; `formatQualifiedDate` turns those back into the
 * sentence shown underneath. Both are pure modules with their own tests, which
 * is what keeps the interesting half of this feature assertable as a table of
 * strings rather than through a mounted component. What is left here is the
 * three things only a component can do: hold the text, decide *when* to
 * complain about it, and put the parsed values where a form submission will
 * find them.
 *
 * ## Why the parsed values are hidden inputs
 *
 * The visible box has no `name` at all. It is the author's phrasing, and the
 * database has no column for it. What posts is the five hidden inputs below,
 * named exactly as the columns are — so `individualInputFromFormData` and
 * `unionInputFromFormData` read them with no knowledge that a date field ever
 * became free text, and so a form still submits with JavaScript mid-flight.
 * Two of the five exist because of `YEO-88`: a range typed as `between 1890
 * and 1900` has an upper bound as real as its lower one, and if this
 * component posted only the three it always posted, that upper bound would
 * vanish on every save with nothing reporting it — the collapse this ticket
 * reversed, happening again one save at a time. See `IndividualFormField` in
 * `components/IndividualFieldset.tsx` for the compile-time guard that keeps
 * the two new fields from being left out of a form's values.
 *
 * The one case worth reading twice is unparseable text: it is posted *raw*,
 * into the date field. That looks odd until you consider the alternative,
 * which is posting an empty date — and an empty date is a save that appears to
 * succeed while quietly discarding what somebody typed. Posting the text means
 * `readDate` refuses it on the server and the form comes back with a message
 * beside the field, which is the same path every other bad value takes. The
 * inline message below is the fast version of the same answer, not a
 * replacement for it.
 */

export interface DateFieldProps {
  /** The word above the box: "Born", "Died", "Started", "Ended". */
  legend: string;
  /**
   * The `name` of the hidden date input. The qualifier and precision post as
   * `${name}Qualifier` and `${name}Precision`, and — since `YEO-88` — a
   * range's upper bound posts as `${name}Upper` and `${name}UpperPrecision`,
   * matching the column names the validators read.
   */
  name: string;
  /** The raw text, exactly as typed. Held by the caller. */
  value: string;
  /** The text changed. The caller stores it unparsed. */
  onChange: (value: string) => void;
  /**
   * What the server said about this date, if anything. Rendered when there is
   * no inline parse message to show instead.
   */
  error?: string;
  disabled?: boolean;
  /** The caller's own input styling, so each form keeps one class list. */
  className?: string;
}

export function DateField({
  legend,
  name,
  value,
  onChange,
  error,
  disabled = false,
  className,
}: DateFieldProps) {
  const base = useId();
  const inputId = `${base}-input`;
  const hintId = `${base}-hint`;
  const previewId = `${base}-preview`;
  const errorId = `${base}-error`;

  /**
   * Whether the author has finished with this field at least once — which is
   * to say, when to start complaining.
   *
   * Not while typing. Every date passes through unreadable states on the way
   * to being written — `1`, `18`, `abo` — and a field that reddens at each of
   * them is telling the author they are wrong for having a keyboard. Blur is
   * the first moment they have said they are finished, so it is the first
   * moment an inline message is information rather than interruption. A
   * message from the *server* is shown immediately regardless: that one is
   * about a submission that has already happened.
   *
   * Local rather than lifted, and one-way: nothing outside needs to see it and
   * nothing ever needs to set it back. A form that comes back refused keeps
   * it, which is correct — the author has certainly finished by then.
   */
  const [blurred, setBlurred] = useState(false);

  const parsed = parseDateInput(value);
  const understood =
    parsed.ok && parsed.value ? formatQualifiedDate(parsed.value) : null;

  const message = (!parsed.ok && blurred ? parsed.message : undefined) ?? error;

  const describedBy = [
    hintId,
    understood ? previewId : null,
    message ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <label htmlFor={inputId} className="block text-caption text-ink-muted">
        {legend}
      </label>

      <input
        id={inputId}
        type="text"
        /**
         * Deliberately unnamed — see the note on hidden inputs above. Also
         * `autoComplete="off"`: a browser offering last week's search terms
         * under a field labelled "Born" is noise at best.
         */
        autoComplete="off"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setBlurred(true)}
        aria-invalid={message !== undefined}
        aria-describedby={describedBy}
        placeholder="1890, about 1890, 12 March 1890"
        className={className}
      />

      <input type="hidden" name={name} value={postedDate(parsed, value)} />
      <input
        type="hidden"
        name={`${name}Qualifier`}
        value={parsed.ok && parsed.value ? parsed.value.qualifier : "exact"}
      />
      <input
        type="hidden"
        name={`${name}Precision`}
        value={parsed.ok && parsed.value ? parsed.value.precision : "day"}
      />
      <input
        type="hidden"
        name={`${name}Upper`}
        value={parsed.ok && parsed.value ? (parsed.value.upper ?? "") : ""}
      />
      <input
        type="hidden"
        name={`${name}UpperPrecision`}
        value={parsed.ok && parsed.value ? parsed.value.upperPrecision : "day"}
      />

      {/*
       * The hint is always on screen rather than behind a "?" or a tooltip.
       * It is the entire discoverability of the feature: without it the box
       * reads as an ordinary date field and nobody discovers that "about
       * 1890" is allowed, which would leave the dropdown removed and the
       * problem it caused unsolved.
       */}
      <p id={hintId} className="mt-1 text-note text-ink-muted">
        A year, a rough year, or a full date — 1890, about 1890, before 1920, 12
        March 1890.
      </p>

      {understood ? (
        /*
         * The echo. `aria-live` so a screen reader hears the interpretation
         * change as it is typed, which is the whole point of showing it: an
         * author who typed "c. 1890" needs to see that it landed as "about
         * 1890" and not as something else.
         */
        <p
          id={previewId}
          aria-live="polite"
          className="mt-1 text-note text-ink-muted"
        >
          Understood as <span className="text-ink">{understood}</span>
        </p>
      ) : null}

      {message === undefined ? null : (
        <p id={errorId} role="alert" className="mt-1 text-note text-ink">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * What goes in the date input that actually posts.
 *
 * Three cases, and the third is the one this ticket is about: a parsed date
 * posts its ISO day, a blank field posts nothing, and text that could not be
 * read posts *itself* so the server refuses the save rather than accepting it
 * with the date silently missing.
 */
function postedDate(
  parsed: ReturnType<typeof parseDateInput>,
  raw: string,
): string {
  if (!parsed.ok) return raw;
  return parsed.value?.date ?? "";
}
