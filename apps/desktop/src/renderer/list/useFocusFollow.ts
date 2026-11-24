// Keeps keyboard focus on an item when its row or card is replaced: an item that moves to
// another group or column is rendered anew, which would drop focus to the page. The item that
// had focus is remembered; when focus has fallen to the page after a render, it goes back to
// that item's row or card. A blur that leaves the element in place (Tab, a click elsewhere)
// forgets it.
import { type FocusEvent, useLayoutEffect, useRef } from "react";

export const itemElement = (itemId: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[data-item-id]")].find((element) => element.dataset["itemId"] === itemId);

export function useFocusFollow() {
  const focused = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (focused.current !== undefined && (document.activeElement === document.body || document.activeElement === null)) itemElement(focused.current)?.focus();
  });
  return {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      focused.current = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]")?.dataset["itemId"];
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.target.isConnected) focused.current = undefined;
    },
  };
}
