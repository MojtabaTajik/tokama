// A searchable dropdown that opens upward from its button, for one choice or several. Focus moves
// to the search field on open; Up and Down move through the matches, Enter picks (a multi-select
// stays open and toggles), Escape closes and returns focus to the button. Option labels come
// from the engine and render as React text only.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/Button.js";
import { markOf } from "../ui/status.js";

export interface PickerOption {
  readonly id: string;
  readonly label: string;
  /** A short word after the label, such as "suggested". */
  readonly tag?: string | undefined;
}

export interface PickerGroup {
  readonly heading?: string;
  readonly options: readonly PickerOption[];
}

export interface PickerProps {
  /** What the dropdown chooses, shown on its button: "Template". */
  readonly label: string;
  /** The current choice, shown on the button. */
  readonly summary: string;
  readonly searchLabel: string;
  readonly groups: readonly PickerGroup[];
  readonly selected: ReadonlySet<string>;
  readonly multi: boolean;
  readonly onPick: (id: string) => void;
}

const NO_MATCH = "No match";

export function Picker({ label, summary, searchLabel, groups, selected, multi, onPick }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const needle = query.trim().toLowerCase();
  const shown = groups.map((group) => ({ ...group, options: group.options.filter((option) => option.label.toLowerCase().includes(needle)) })).filter((group) => group.options.length > 0);
  const flat = shown.flatMap((group) => group.options);
  const index = Math.min(active, flat.length - 1);
  const optionId = (id: string) => `${listId}-${id}`;

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };
  const show = () => {
    setActive(Math.max(0, groups.flatMap((group) => group.options).findIndex((option) => selected.has(option.id))));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The active option stays in view while the arrow keys move through a long list.
  useEffect(() => {
    if (open) root.current?.querySelector('[role="option"][data-active]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, index, query]);

  const pick = (id: string) => {
    onPick(id);
    if (!multi) close(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const move = (to: number) => {
      event.preventDefault();
      if (flat.length > 0) setActive((to + flat.length) % flat.length);
    };
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const option = flat[index];
      if (option) pick(option.id);
    }
  };

  return (
    <div
      className="np-picker"
      ref={root}
      onBlur={(event) => {
        // Tab out of the dropdown closes it; a click elsewhere is handled by the mousedown listener.
        if (open && event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) close(false);
      }}
    >
      <Button
        variant="plain"
        ref={trigger}
        className="np-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="np-trigger-label">{label}</span>
        <span className="ellipsis">{summary}</span>
        <span aria-hidden="true">▾</span>
      </Button>
      {open && (
        <div className="np-popup">
          <input
            ref={search}
            type="text"
            role="combobox"
            className="np-search"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[index] ? optionId(flat[index].id) : undefined}
            placeholder={`${searchLabel}…`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div id={listId} role="listbox" aria-label={label} aria-multiselectable={multi || undefined} className="np-list">
            {shown.map((group, position) => (
              <div key={group.heading ?? position} role="group" aria-label={group.heading}>
                {group.heading !== undefined && (
                  <span className="np-group" aria-hidden="true">
                    {group.heading}
                  </span>
                )}
                {group.options.map((option) => (
                  <div
                    key={option.id}
                    id={optionId(option.id)}
                    role="option"
                    aria-selected={selected.has(option.id)}
                    className="np-option"
                    data-active={flat[index]?.id === option.id || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(option.id)}
                  >
                    <span className="np-check" aria-hidden="true">
                      {selected.has(option.id) ? markOf("passed").symbol : ""}
                    </span>
                    <span className="ellipsis">{option.label}</span>
                    {option.tag !== undefined && <span className="np-tag">{option.tag}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {flat.length === 0 && (
            <p className="np-empty" role="status">
              {NO_MATCH}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
