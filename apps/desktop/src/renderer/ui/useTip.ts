// The open and close timing every hover tooltip shares: the pointer must rest before it opens and
// be away for a moment before it closes, so the enter and leave events a pointer sends at an
// edge never make it flicker. Focus opens it at once.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How long the pointer rests on the trigger before the tooltip opens, and how long it may be away before it closes. */
export const TIP_OPEN_MS = 120;
export const TIP_CLOSE_MS = 200;

/**
 * Whether a tooltip shows. Hover opens it after a short rest and closes it after a short
 * absence; a leave and a new enter within that time change nothing. Focus opens it at once. A
 * dismissed tooltip comes back when the pointer or the focus returns. While `suppressed`, it stays
 * closed whatever the pointer does. `onShown` hears each change once.
 */
export function useTip(onShown: ((shown: boolean) => void) | undefined, suppressed = false) {
  const [open, setOpen] = useState(false);
  const state = useRef({ hover: false, focus: false, dismissed: false, open: false, suppressed });
  state.current.suppressed = suppressed;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useRef(onShown);
  notify.current = onShown;
  const show = useCallback((next: boolean) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (state.current.open === next) return;
    state.current.open = next;
    setOpen(next);
    notify.current?.(next);
  }, []);
  const hold = useCallback(
    (by: "hover" | "focus", held: boolean) => {
      const s = state.current;
      s[by] = held;
      // A dismissed tooltip comes back when the pointer or the focus returns.
      if (held || (!s.hover && !s.focus)) s.dismissed = false;
      const wanted = (s.hover || s.focus) && !s.dismissed && !s.suppressed;
      clearTimeout(timer.current);
      timer.current = undefined;
      if (wanted === s.open) return;
      if (wanted && s.focus) return show(true);
      timer.current = setTimeout(() => show(wanted), wanted ? TIP_OPEN_MS : TIP_CLOSE_MS);
    },
    [show],
  );
  const dismiss = useCallback(() => {
    state.current.dismissed = true;
    show(false);
  }, [show]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (suppressed) show(false);
  }, [suppressed, show]);
  // The handlers for the element that holds the trigger and the tooltip: moving between the two keeps it open.
  const triggers = useMemo(
    () => ({
      onMouseEnter: () => hold("hover", true),
      onMouseLeave: () => hold("hover", false),
      onFocus: () => hold("focus", true),
      onBlur: () => hold("focus", false),
    }),
    [hold],
  );
  return { open, hold, dismiss, triggers };
}

/**
 * The tooltip of a piece of text inside a button (a row, a card) or a heading: it shows while the pointer is
 * on that host or the keyboard focus is in it, so the text is not a tab stop of its own. Put `ref` on the
 * text; the host is its closest button, else its parent. `active` false (nothing to show) listens to nothing.
 */
export function useHostTip(active = true) {
  const ref = useRef<HTMLElement>(null);
  const { open, hold } = useTip(undefined);
  useEffect(() => {
    const host = active ? (ref.current?.closest("button") ?? ref.current?.parentElement) : null;
    if (host === null || host === undefined) return;
    const handlers = [
      ["mouseenter", () => hold("hover", true)],
      ["mouseleave", () => hold("hover", false)],
      ["focusin", () => hold("focus", true)],
      ["focusout", () => hold("focus", false)],
    ] as const;
    for (const [type, handler] of handlers) host.addEventListener(type, handler);
    return () => {
      for (const [type, handler] of handlers) host.removeEventListener(type, handler);
    };
  }, [active, hold]);
  return { ref, open };
}
