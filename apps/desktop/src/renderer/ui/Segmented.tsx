// Segmented: a row of options where exactly one is chosen, as a radio group. The chosen option
// shows a ✓ before its words, so colour is never the only signal. Arrow keys, Home and End move
// the choice (and the focus with it); only the chosen option is in the Tab order.
import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "./Button.js";

export interface SegmentedProps<T extends string> {
  /** `icon` is drawn in place of the label, which then names the option for screen readers and as its hover title. */
  readonly options: readonly { readonly value: T; readonly label: string; readonly icon?: ReactNode }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** The id of the element that names the group; or use `label`. */
  readonly labelledBy?: string | undefined;
  /** What the group chooses, for screen readers, when no element names it. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

export function Segmented<T extends string>({ options, value, onChange, labelledBy, label, className }: SegmentedProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = options.findIndex((option) => option.value === value);
    const last = options.length - 1;
    const to = event.key === "ArrowRight" || event.key === "ArrowDown" ? at + 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? last : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const index = (to + options.length) % options.length;
    const next = options[index];
    if (next === undefined) return;
    onChange(next.value);
    // The group re-renders with the new option in the Tab order; focus follows it.
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  };
  return (
    <div className={["segmented", className].filter(Boolean).join(" ")} role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy === undefined ? label : undefined} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <Button
            key={option.value}
            variant="plain"
            className="segmented-option"
            role="radio"
            aria-checked={chosen}
            aria-label={option.icon === undefined ? undefined : option.label}
            title={option.icon === undefined ? undefined : option.label}
            tabIndex={chosen ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {chosen ? (
              <span className="segmented-check" aria-hidden="true">
                ✓
              </span>
            ) : null}
            {option.icon ?? option.label}
          </Button>
        );
      })}
    </div>
  );
}
