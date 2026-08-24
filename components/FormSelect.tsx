"use client";

import { useEffect, useRef } from "react";

/**
 * A `<select>` that survives the reset React performs on every form-action
 * submission (E3-T4, `YEO-32`).
 *
 * ## The bug this exists to fix
 *
 * E3-T2 established that inputs in a form with an `action` must be controlled,
 * because React calls `requestFormReset` on every submission — before the
 * action runs, without waiting to see what it says. Holding the value in state
 * was said to make that reset a no-op.
 *
 * For `<input>` and `<textarea>` it does, but for a *different* reason than
 * "it is controlled": React writes `node.defaultValue` alongside `node.value`,
 * so the value a reset restores is the value that was already there. React
 * does **not** do the equivalent for `<select>` — the DOM default of a select
 * is the `defaultSelected` flag on each `<option>`, and React never touches
 * it. A reset therefore reverts every controlled select to its *first option*,
 * and React does not re-render (its own props did not change), so nothing puts
 * it back.
 *
 * The result is silent and specific: submit a refused add-spouse form and the
 * marriage you recorded as a partnership is a marriage again, "about 1912" is
 * exact, and a partner you recorded as female is male — because `male` happens
 * to be the first member of `SEXES`. Nothing looks broken. The author fixes
 * the one field they were told about and saves three answers they never gave.
 *
 * ## The fix
 *
 * Keep `defaultSelected` in step with the value, which is exactly what React
 * already does for inputs. The effect runs on every change, long before any
 * submission, so by the time a reset happens the DOM default *is* the current
 * value and the reset restores it unchanged.
 *
 * Done imperatively because there is no declarative route: React warns if you
 * put `selected` on an `<option>` inside a select that has a `value`, and it
 * is right to — that is the uncontrolled spelling. This sets the *default*,
 * which is a different flag and the one a reset reads.
 *
 * Used by `AddSpouseForm` and by `IndividualFieldset`, whose `sex` and two
 * date-qualifier selects have the same problem.
 */
export interface FormSelectProps
  extends Omit<React.ComponentProps<"select">, "defaultValue"> {
  /** The chosen value. Controlled, like every other field in these forms. */
  value: string;
}

export function FormSelect({ value, ...props }: FormSelectProps) {
  const ref = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const select = ref.current;
    if (!select) return;

    for (const option of select.options) {
      option.defaultSelected = option.value === value;
    }
  }, [value, props.children]);

  return <select ref={ref} value={value} {...props} />;
}
