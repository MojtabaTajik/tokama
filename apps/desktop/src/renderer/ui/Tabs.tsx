// Tabs: a tablist whose arrow keys (and Home and End) move between tabs, with only the selected
// tab in the Tab order. The screen renders the panel; `idOf` and `panelIdOf` tie the two together.
import type { KeyboardEvent } from "react";
import { Button } from "./Button.js";

export interface TabsProps<T extends string> {
  readonly tabs: readonly T[];
  readonly selected: T;
  readonly onSelect: (tab: T) => void;
  /** What the tabs switch between, for screen readers. */
  readonly label: string;
  /** A tab's words; the tab itself by default. */
  readonly labelOf?: (tab: T) => string;
  /** The id of a tab's element, so its panel can say it is labelled by it. */
  readonly idOf?: (tab: T) => string;
  /** The id of the selected tab's panel. */
  readonly panelIdOf?: (tab: T) => string;
  readonly className?: string | undefined;
}

export function Tabs<T extends string>({ tabs, selected, onSelect, label, labelOf = (tab) => tab, idOf, panelIdOf, className }: TabsProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.indexOf(selected);
    const to = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length] ?? selected;
    onSelect(next);
    // The tab list re-renders with the new tab in the Tab order; focus follows it.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[tabs.indexOf(next)]?.focus();
  };
  return (
    <div className={["tabs", className].filter(Boolean).join(" ")} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <Button
          variant="plain"
          key={tab}
          role="tab"
          className="tab"
          id={idOf?.(tab)}
          aria-selected={tab === selected}
          aria-controls={tab === selected ? panelIdOf?.(tab) : undefined}
          tabIndex={tab === selected ? 0 : -1}
          onClick={() => onSelect(tab)}
        >
          {labelOf(tab)}
        </Button>
      ))}
    </div>
  );
}
