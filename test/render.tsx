import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

/**
 * Mounting a component, for the handful of tests that genuinely need a
 * document.
 *
 * docs/testing.md said when to write this: "Rendering is eight lines of
 * `react-dom/client` and React's own `act` … copy it rather than reaching for a
 * library; if a third component wants it, that is the moment to extract a
 * helper, not before." E2-T1 brought the second and third —
 * `components/PersonPanel.test.tsx` and `components/FamilyTree.test.tsx` — so
 * this is that moment, and it is still eight lines rather than a testing
 * library.
 *
 * It stays deliberately thin. No queries, no user-event, no auto-wrapping:
 * files reach into the returned host with plain DOM calls, which is what keeps
 * "prefer no DOM" an easy rule to follow — nothing here is nicer than testing a
 * plain module, so nothing here tempts anyone into mounting a component to
 * check a decision that could have been a function.
 *
 * Every test file that imports this still needs `// @vitest-environment jsdom`
 * on its first line. Vitest reads that per file, which is what keeps the rest
 * of the suite running in plain Node.
 */

const roots = new Map<HTMLElement, Root>();

/**
 * Registered at import time, which is to say once per test file that imports
 * this module — Vitest collects a file by executing it, and its imports with
 * it. So each file gets its own teardown against this module's map, and a
 * component left mounted by a failing assertion cannot leak into the next test.
 */
afterEach(() => {
  for (const host of [...roots.keys()]) unmount(host);
  document.body.innerHTML = "";
});

/** Mount `ui` into a fresh host attached to the document, and return the host. */
export function render(ui: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.set(host, root);
  act(() => root.render(ui));
  return host;
}

/**
 * Render again into the same root: a prop change rather than a remount, which
 * is the only way to test what a component does when its props change under it.
 */
export function rerender(host: HTMLElement, ui: ReactElement): void {
  const root = roots.get(host);
  if (!root)
    throw new Error("rerender() was given a host nothing is mounted in");
  act(() => root.render(ui));
}

/**
 * Unmount now rather than at the end of the test — for the assertions that are
 * *about* unmounting, such as whether a component removed the document-level
 * listener it added.
 */
export function unmount(host: HTMLElement): void {
  const root = roots.get(host);
  if (!root) return;
  roots.delete(host);
  act(() => root.unmount());
  host.remove();
}
