// The status switch at the top of every view: Active, Needs you, Done, Failed, All, each with its
// count, a Today / 7 days / 30 days / All time picker for Done, Failed and All, and at the right
// end the search: its result count, the field, and a clear button (Esc clears too).
import type { ItemRecord } from "@tokama/core";
import { type Filter, filterCounts, hasRange, type Range, RANGES, STATUS_FILTERS, type StatusFilter as Status } from "../model.js";
import { SearchIcon } from "../ui/icons.js";

const TEXT = {
  group: "Status filter",
  range: "Time range",
  search: "Search work",
  searchField: "Search work by title, repo, template or agent",
  placeholder: "Search all work",
  clear: "Clear search (Esc)",
  results: (n: number) => (n === 1 ? "result" : "results"),
} as const;

export interface SearchProps {
  /** What is typed. */
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly onClear: () => void;
  /** The matches of the last search; undefined while there is none or it is on its way. */
  readonly results: number | undefined;
}

export interface StatusFilterProps {
  /** The items of the current view. */
  readonly items: readonly ItemRecord[];
  readonly filter: Filter;
  readonly now: number;
  readonly onChange: (patch: Partial<Filter>) => void;
  /** The search field; without it there is none (the Board layout). */
  readonly search?: SearchProps | undefined;
}

export function StatusFilter({ items, filter, now, onChange, search }: StatusFilterProps) {
  const counts = filterCounts(items, filter, now);
  return (
    <div className="filter-bar">
      <div className="segments" role="group" aria-label={TEXT.group}>
        {STATUS_FILTERS.map(({ id, label }) => {
          const count = id === "all" ? undefined : counts[id];
          return (
            <button key={id} type="button" className="segment" aria-pressed={filter.status === id} data-kind={id} onClick={() => onChange({ status: id as Status })}>
              <span>{label}</span>
              {count !== undefined && (
                <span className="segment-count mono" data-active={count > 0 || undefined}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {hasRange(filter.status) && (
        <select className="range" aria-label={TEXT.range} value={filter.range} onChange={(event) => onChange({ range: event.target.value as Range })}>
          {RANGES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      {search !== undefined && <Search {...search} />}
    </div>
  );
}

function Search({ text, onText, onClear, results }: SearchProps) {
  return (
    <div className="search" role="search" aria-label={TEXT.search}>
      {text.trim() !== "" && results !== undefined && (
        <span className="search-count" aria-live="polite">
          <span className="mono">{results}</span> {TEXT.results(results)}
        </span>
      )}
      <span className="search-field">
        <SearchIcon />
        <input
          type="text"
          className="search-input"
          data-active={text !== "" || undefined}
          placeholder={TEXT.placeholder}
          aria-label={TEXT.searchField}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || text === "") return;
            event.preventDefault();
            event.stopPropagation();
            onClear();
          }}
        />
        {text !== "" && (
          <button type="button" className="search-clear" aria-label={TEXT.clear} title={TEXT.clear} onClick={onClear}>
            ✕
          </button>
        )}
      </span>
    </div>
  );
}
