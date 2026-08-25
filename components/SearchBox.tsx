"use client";

import Form from "next/form";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { SearchSuggestions } from "@/components/SearchSuggestions";
import { useDismissableSurface } from "@/components/surface-stack";
import {
  SEARCH_QUERY_PARAM,
  parseSearchSuggestions,
  searchEndpointUrl,
} from "@/lib/search-endpoint";
import {
  SEARCH_KEY_SHORTCUTS,
  keyboardHint,
  opensSearch,
} from "@/lib/search-shortcut";
import {
  idleSuggestionState,
  nextOptionKey,
  requestFailed,
  requestStarted,
  responseArrived,
  shouldRequest,
  suggestionOptions,
  typed,
} from "@/lib/suggestion-state";

/**
 * One box, in the header, on every page (E8-T3, `YEO-57`).
 *
 * The ticket's note is the whole design: *"The author should never have to
 * decide whether they are looking for 'a person' or 'an entry' before typing.
 * One box, grouped results."* This is that box; `components/SearchSuggestions.tsx`
 * is what appears underneath it, and `app/search/page.tsx` is where Enter
 * goes.
 *
 * ## What was here before
 *
 * An inert `aria-hidden` div, until E8-T2 (`YEO-56`) gave it somewhere to go
 * and it became a plain link to `/search`. The reasoning recorded then — a
 * control that looks like search and does nothing is a worse promise than one
 * that is not announced at all — is why the link was the right interim step
 * and why this is the right one now that there is an endpoint to feed it.
 *
 * ## Still a real GET form
 *
 * The `next/form` around the input is not decoration. `app/search/page.tsx`
 * chose a GET form over client state specifically so that a search is
 * bookmarkable, shareable, and survives the back button, and that argument
 * does not stop applying because there is now a dropdown. With JavaScript
 * off, or before hydration, this degrades to exactly the control that was
 * here yesterday: type, press Enter, land on `/search?q=…`. The suggestions
 * are an enhancement layered on top of a thing that already worked — which is
 * also why the error state's advice is "press Enter" rather than "retry".
 *
 * ## Why a combobox and not a ⌘K spotlight dialogue
 *
 * The full argument is in `components/SearchSuggestions.tsx`. In short: a
 * `role="combobox"` is the pattern screen readers actually implement, and a
 * `role="dialog"` wrapper would buy `aria-modal`'s "everything else is inert"
 * promise — which then has to be kept with a focus trap — around a combobox
 * you need anyway. Two patterns, the semantics of one. The cost is that ⌘K
 * focuses a header field rather than opening a centred panel; the panel below
 * is `fixed` and full-bleed under `sm`, so the *results* are never cramped
 * even where the box is.
 *
 * ## The `YEO-83` hazard, which is the easiest thing here to get wrong
 *
 * The Escape registration lives in `<PanelSurface>`, which mounts **with the
 * panel** and unmounts with it. It must not move up into this component.
 * `useDismissableSurface` pushes on mount and pops on unmount, and its
 * document listener exists only while the stack is non-empty — so a search
 * box registered for the life of the header would put a permanently-topmost
 * surface underneath every dialogue in the application and swallow the
 * Escapes meant for them. The panel is the surface; the box is not.
 *
 * Outside-dismissal is handled here rather than there, because it is a
 * different question from Escape and `components/surface-stack.ts`
 * deliberately does not answer it. Two listeners, because they are two exits:
 * a `focusout` whose `relatedTarget` has left the wrapper (tabbing away), and
 * a document `pointerdown` outside it (a click on chrome that takes no
 * focus). Both are mounted only while the panel is open.
 */

/**
 * How long the box waits after a keystroke before asking.
 *
 * A fluent typist's median inter-keystroke interval is roughly 150–200ms, so
 * a debounce at the top of that band issues about one request per *word*
 * rather than one per letter — while a 200ms pause is still below the
 * ~250–300ms at which an interface starts to feel like it is thinking.
 *
 * The cost being avoided is real rather than theoretical: `searchPeopleByName`
 * reads the **entire** `individuals` table on every call and ranks it in
 * TypeScript. Its own docblock argues for that correctly, for a page load;
 * this ticket puts it on a per-keystroke path, and 200ms is where "instant"
 * and "not hammering the table" meet.
 */
const DEBOUNCE_MS = 200;

/**
 * `navigator.userAgentData` is not in the default TypeScript DOM library.
 * Declared narrowly and locally rather than as a global `.d.ts`: one optional
 * property, read defensively, wanted by one file.
 */
type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

/** Nothing to subscribe to — the platform does not change under a tab. */
function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * What the server renders, and what hydration starts from: nothing, because
 * the server cannot know the platform. Module scope, like its two siblings —
 * an inline `() => null` would be a fresh closure on every render, which is
 * harmless here (React consults it only during the hydration pass) but is one
 * more thing a reader has to convince themselves of.
 */
function noKeyboardHint(): null {
  return null;
}

function readKeyboardHint(): string | null {
  const nav = navigator as NavigatorWithUserAgentData;
  return keyboardHint(
    nav.userAgentData?.platform ?? nav.platform,
    nav.userAgent,
    nav.maxTouchPoints,
  );
}

/**
 * What to print in the `<kbd>`, without a hydration mismatch.
 *
 * The server cannot know the platform, so rendering `⌘K` there and `Ctrl K`
 * on the client is a text mismatch — which React 19 does not merely warn
 * about, it discards and re-renders the subtree. `useSyncExternalStore` with
 * a `getServerSnapshot` is the pattern this repository has already argued
 * for once, in `components/sidebar-state.ts`: the server pass and the
 * hydration pass both render `null`, and the real label arrives in the commit
 * *after* hydration, as a state update rather than a disagreement.
 *
 * Two alternatives, both rejected. A second inline boot script setting
 * `data-platform` on `<html>` would be correct on the first paint and cost no
 * React at all — but `lib/sidebar-preference.ts` earns its script because a
 * flash of collapsed sidebar is intolerable furniture movement, and a
 * keyboard hint arriving one commit late is not. One boot script is a
 * considered exception; two is a habit. And `suppressHydrationWarning` would
 * silence the report without making the two trees agree, which is how a
 * genuine mismatch somewhere else gets hidden for a year.
 */
function useKeyboardHint(): string | null {
  return useSyncExternalStore(
    subscribeToNothing,
    readKeyboardHint,
    noKeyboardHint,
  );
}

export function SearchBox({ siteName }: { siteName: string }) {
  const [state, setState] = useState(idleSuggestionState);
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The latest state, for the fetch effect below — which is keyed on the
   * query alone and must not re-run when an answer arrives for it.
   */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  /**
   * Ids for the combobox relationship. `useId` rather than a fixed string:
   * `app/search/page.tsx` renders its own `id="search-query"`, and once this
   * box is on every page the two of them share a document. A duplicate id is
   * a silent way for one control's `aria-controls` to resolve to the other's
   * list — the same trap `ModalDialog` records for its own title.
   */
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const statusId = `${baseId}-status`;
  const optionId = useCallback(
    (key: string) => `${baseId}-option-${key}`,
    [baseId],
  );

  const hint = useKeyboardHint();

  const options = suggestionOptions(state);
  const activeOption =
    options.find((option) => option.key === activeKey) ?? null;

  const close = useCallback(() => {
    setOpen(false);
    setActiveKey(null);
  }, []);

  /**
   * The shortcut, from anywhere on the page — the ticket's third acceptance
   * criterion.
   *
   * One `document` listener for the life of the header, and deliberately
   * **not** on the surface stack: that registry answers "which open surface
   * is this keystroke for", and an open-shortcut is the opposite question.
   * The argument is written out in `lib/search-shortcut.ts`, along with what
   * would change the answer.
   *
   * `opensSearch` is what decides; everything below it is wiring. `select()`
   * so that ⌘K over a box that already has a query replaces it, which is what
   * every other search field on the machine does.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!opensSearch(event, target)) return;

      event.preventDefault();
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * A click outside the box, on something that takes no focus. The
   * `focusout` on the wrapper covers tabbing away; this covers a press on
   * page chrome, which would otherwise leave the panel hanging over content
   * the reader has moved on to. Mounted only while the panel is open, so a
   * page with nothing open carries no listener.
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) {
        return;
      }
      close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  /**
   * Ask, once the typing stops.
   *
   * Keyed on the query alone. A `setTimeout` in an effect rather than
   * `useDeferredValue`, which defers *rendering* and would issue every
   * request anyway; the cleanup both cancels a pending timer and aborts a
   * request already in flight, so a keystroke costs at most one abandoned
   * round trip.
   */
  useEffect(() => {
    const query = state.query;
    /**
     * `stateRef.current` is `state` as of **this** commit, not a later one:
     * the assignment above is an effect of this component with no dependency
     * array, and React runs a component's effects in declaration order, so it
     * has already run for this render by the time this one does. So this is
     * the same `state` the line above destructured, read through a ref only
     * so that this effect can depend on the query alone and not re-run — and
     * re-fire the debounce — when an answer arrives for it.
     */
    if (!shouldRequest(stateRef.current, query)) return;

    const controller = new AbortController();

    const timer = setTimeout(() => {
      setState((current) => requestStarted(current, query));

      void (async () => {
        try {
          const response = await fetch(searchEndpointUrl(query), {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
          if (!response.ok) {
            throw new Error(`search responded ${response.status}`);
          }

          const parsed = parseSearchSuggestions(await response.json());
          if (parsed === null) throw new Error("unrecognised search payload");

          setState((current) => responseArrived(current, parsed));
        } catch {
          /**
           * **An abort is not a failure**, and this check is the difference
           * between a working box and one that flashes an error on every
           * keystroke. Every keystroke aborts the request before it, and
           * every abort rejects that request's promise — so without this,
           * the error copy would paint over correct results as they arrive.
           * The check belongs here rather than in `lib/suggestion-state.ts`
           * because the signal is here; that module never sees an abort at
           * all, which is why it can say so plainly.
           */
          if (controller.signal.aborted) return;
          setState((current) => requestFailed(current, query));
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [state.query]);

  return (
    <div
      ref={wrapperRef}
      className="relative min-w-0 flex-1 sm:max-w-96"
      /**
       * Focus left the box altogether — tabbed past the last option, or into
       * the account menu. `relatedTarget` is null when focus went nowhere the
       * document can name (another window), which counts as leaving.
       */
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        close();
      }}
    >
      <Form action="/search" role="search">
        {/*
          The page's own label text, and its argument: the box asks one
          question of both people and entries, so naming only one of them
          would be telling a screen-reader user the narrower of two truths.
        */}
        <label className="sr-only" htmlFor={inputId}>
          Search people and entries
        </label>

        <div className="flex items-center gap-1 rounded-panel border border-rule-soft bg-paper px-2 focus-within:border-rule">
          <input
            ref={inputRef}
            id={inputId}
            type="search"
            name={SEARCH_QUERY_PARAM}
            placeholder={`Search ${siteName}`}
            autoComplete="off"
            role="combobox"
            /*
              Only while the listbox is actually rendered. The combobox
              pattern wants `aria-controls` on the input, but an IDREF that
              resolves to nothing is worse than an absent one — some screen
              readers report the relationship and then find no list to move
              into. It is present exactly when `aria-expanded` is true, which
              is when there is a list to point at.
            */
            aria-controls={open && options.length > 0 ? listboxId : undefined}
            /**
             * `open && options.length > 0`, not `open`. An expanded listbox
             * with nothing in it is announced as an empty listbox, which is a
             * worse answer than a collapsed one — while the panel is still
             * *shown*, because the sentence inside it is the point. Visual
             * presence and `aria-expanded` are answering different questions;
             * this looks like a bug and is not.
             */
            aria-expanded={open && options.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={
              activeOption ? optionId(activeOption.key) : undefined
            }
            aria-describedby={open ? statusId : undefined}
            aria-keyshortcuts={SEARCH_KEY_SHORTCUTS}
            className="min-w-0 flex-1 bg-transparent py-1 text-caption text-ink outline-none"
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setState((current) => typed(current, event.target.value));
              setActiveKey(null);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const next = nextOptionKey(
                  options,
                  activeKey,
                  event.key === "ArrowDown" ? 1 : -1,
                );
                // Nothing to move through: leave the caret keys alone so they
                // still do what they do in a text field.
                if (next === null) return;
                event.preventDefault();
                setOpen(true);
                setActiveKey(next);
                return;
              }

              if (event.key === "Enter" && activeOption !== null) {
                /**
                 * A row is chosen, so this is a navigation rather than a
                 * search — and the way it is performed is by clicking the row,
                 * which is a `next/link` and therefore a client-side
                 * transition. Going through the element rather than
                 * `useRouter().push` is what keeps mouse and keyboard on one
                 * path instead of two that can drift; it also keeps this
                 * component out of `next/navigation`, which cannot be
                 * rendered outside an app-router context and so would have
                 * had to be mocked to test any of the rest of this file.
                 *
                 * `getElementById` rather than a `querySelector`: `useId`
                 * produces ids containing characters that are not valid in a
                 * CSS selector without escaping.
                 */
                event.preventDefault();
                document.getElementById(optionId(activeOption.key))?.click();
                close();
              }
            }}
          />

          {/*
            `aria-hidden` because `aria-keyshortcuts` on the input already
            carries this for assistive tech, and hearing "⌘K" read as text
            after the field's name is noise. The fixed width and the
            non-breaking space keep the header from reflowing when the real
            label arrives one commit after hydration — same element, same
            classes, only the text child changes.
          */}
          <kbd
            aria-hidden="true"
            className="hidden w-12 shrink-0 text-center text-note text-ink-muted sm:block"
          >
            {hint ?? " "}
          </kbd>
        </div>
      </Form>

      {open ? (
        <>
          {/*
            Escape, for as long as the panel is open and only while it is the
            topmost surface. Mounted here, with the panel — see the docblock.
          */}
          <PanelSurface onDismiss={close} inputRef={inputRef} />

          {/*
            Full-bleed under `sm`, where a 96-unit column pinned to the header
            would be too narrow to read a snippet in; anchored to the box
            above it at every wider size.
          */}
          <div className="fixed inset-x-2 z-50 mt-1 sm:absolute sm:inset-x-auto sm:w-full">
            <SearchSuggestions
              state={state}
              listboxId={listboxId}
              optionId={optionId}
              activeKey={activeOption ? activeOption.key : null}
              statusId={statusId}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The panel's registration on the shared surface stack, as a component so
 * that it mounts and unmounts with the panel rather than with the box.
 *
 * This exists only to make the lifetime obvious at the call site. Moving
 * `useDismissableSurface` up into `SearchBox` would compile, would look
 * tidier, and would break `YEO-83` for the whole application — see "The
 * `YEO-83` hazard" above.
 */
function PanelSurface({
  onDismiss,
  inputRef,
}: {
  onDismiss: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  useDismissableSurface({
    onDismiss,
    // Not `modal`: this is a combobox popup, not a dialogue. Nothing here
    // claims the rest of the page is inert, so nothing here traps Tab —
    // tabbing out is a legitimate exit and the `focusout` above takes it.
    returnFocus: () => inputRef.current,
  });
  return null;
}
