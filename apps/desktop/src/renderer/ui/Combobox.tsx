// A dropdown with a search field, for one choice from a long list, with an optional way to use text
// that is not in the list. The button shows the current value. Opened (click, Enter, Space or an
// arrow key), focus moves to the search field: Up and Down move through the matches (and wrap),
// Home and End jump to the ends, Enter picks, Escape closes and returns focus to the button without
// closing a dialog around it, Tab moves on. Enter never submits a surrounding form. Values come
// from the engine and render as React text only.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { markOf } from "./status.js";

export interface ComboboxOption {
  readonly value: string;
  /** A short word after the value, such as "default". */
  readonly tag?: string | undefined;
}

export interface ComboboxGroup {
  readonly heading?: string | undefined;
  readonly options: readonly ComboboxOption[];
}

export interface ComboboxProps {
  /** The button's id, for the label's `htmlFor`. */
  readonly id: string;
  /** The id of the visible label that names the field. */
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  /** What the button shows; empty shows the placeholder. */
  readonly value: string;
  /** A short word after the value on the button, such as "default". */
  readonly valueTag?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly groups: readonly ComboboxGroup[];
  /** The list's name for screen readers: "Branches". */
  readonly listLabel: string;
  /** The search field's name for screen readers. */
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  /** Text that is not listed can be used: a last row says so. Omit to allow listed values only. */
  readonly freeText?: { readonly label: (text: string) => string } | undefined;
  /** Lines of hints under the list. */
  readonly footer?: readonly string[] | undefined;
  /** Values in the code font. */
  readonly mono?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly onChange: (value: string) => void;
}

const NO_MATCH = "No match";

interface Row {
  readonly value: string;
  readonly text: string;
  readonly tag?: string | undefined;
  readonly free: boolean;
}

export function Combobox({ id, labelledBy, describedBy, value, valueTag, placeholder, groups, listLabel, searchLabel, searchPlaceholder, freeText, footer, mono, autoFocus, onChange }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const valueId = `${listId}-value`;

  const needle = query.trim().toLowerCase();
  const shown = groups
    .map((group) => ({ heading: group.heading, options: group.options.filter((option) => option.value.toLowerCase().includes(needle)) }))
    .filter((group) => group.options.length > 0);
  const typed = query.trim();
  const unlisted = freeText !== undefined && typed !== "" && !groups.some((group) => group.options.some((option) => option.value === typed));
  // The matches in order, then the "use this text" row.
  const rows: Row[] = [
    ...shown.flatMap((group) => group.options.map((option) => ({ value: option.value, text: option.value, tag: option.tag, free: false }))),
    ...(unlisted ? [{ value: typed, text: freeText.label(typed), tag: undefined, free: true }] : []),
  ];
  const index = Math.min(active, rows.length - 1);
  const rowId = (position: number) => `${listId}-${position}`;

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };
  const show = () => {
    // A value that is not listed (cut by the cap) starts with no active row, so Enter never replaces it.
    setActive(groups.flatMap((group) => group.options).findIndex((option) => option.value === value));
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

  // The active row stays in view while the arrow keys move through a long list.
  useEffect(() => {
    if (open) root.current?.querySelector('[role="option"][data-active]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, index, query]);

  const pick = (row: Row) => {
    onChange(row.value);
    close(true);
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const move = (to: number) => {
      event.preventDefault();
      if (rows.length > 0) setActive((to + rows.length) % rows.length);
    };
    if (event.key === "Escape") {
      // The dialog around would close on Escape too: this one closes only the list.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? rows.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "Enter") {
      // Never the form's submit: Enter here only chooses.
      event.preventDefault();
      const row = rows[index];
      if (row !== undefined) pick(row);
    }
  };

  let position = -1;
  return (
    <div
      className="combobox"
      ref={root}
      onBlur={(event) => {
        // Tab out of the dropdown closes it; a click elsewhere is handled by the mousedown listener.
        if (open && event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) close(false);
      }}
    >
      <button
        ref={trigger}
        id={id}
        type="button"
        className="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span id={valueId} className="combobox-value">
          <span className={mono === true ? "mono ellipsis" : "ellipsis"}>{value === "" ? placeholder : value}</span>
          {valueTag !== undefined && value !== "" && <span className="combobox-tag"> {valueTag}</span>}
        </span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div
          className="combobox-popup"
          // Keys from anywhere in the popup act as in the search field, so Escape never reaches a dialog around it.
          onKeyDown={onSearchKeyDown}
          // A click on a heading, hint or scroll bar keeps focus in the search field.
          onMouseDown={(event) => {
            if (event.target !== search.current) event.preventDefault();
          }}
        >
          <input
            ref={search}
            type="text"
            role="combobox"
            className="combobox-search"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows[index] === undefined ? undefined : rowId(index)}
            placeholder={searchPlaceholder}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <div id={listId} role="listbox" aria-label={listLabel} className="combobox-list">
            {shown.map((group, groupIndex) => (
              <div key={group.heading ?? groupIndex} role="group" aria-label={group.heading}>
                {group.heading !== undefined && (
                  <span className="combobox-heading" aria-hidden="true">
                    {group.heading}
                  </span>
                )}
                {group.options.map((option) => {
                  const at = ++position;
                  return <OptionRow key={option.value} id={rowId(at)} row={{ value: option.value, text: option.value, tag: option.tag, free: false }} selected={option.value === value} active={at === index} mono={mono === true} onPick={pick} />;
                })}
              </div>
            ))}
            {unlisted && rows.at(-1) !== undefined && (
              <OptionRow id={rowId(rows.length - 1)} row={rows.at(-1)!} selected={false} active={rows.length - 1 === index} mono={false} onPick={pick} />
            )}
          </div>
          {rows.length === 0 && (
            <p className="combobox-empty" role="status">
              {NO_MATCH}
            </p>
          )}
          {footer !== undefined && footer.length > 0 && (
            <div className="combobox-foot">
              {footer.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface OptionRowProps {
  readonly id: string;
  readonly row: Row;
  readonly selected: boolean;
  readonly active: boolean;
  readonly mono: boolean;
  readonly onPick: (row: Row) => void;
}

function OptionRow({ id, row, selected, active, mono, onPick }: OptionRowProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className="combobox-option"
      data-active={active || undefined}
      // Keeps focus in the search field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(row)}
    >
      <span className="combobox-check" aria-hidden="true">
        {selected ? markOf("passed").symbol : ""}
      </span>
      <span className={mono ? "mono ellipsis" : "ellipsis"}>{row.text}</span>
      {row.tag !== undefined && <span className="combobox-option-tag">· {row.tag}</span>}
    </div>
  );
}
