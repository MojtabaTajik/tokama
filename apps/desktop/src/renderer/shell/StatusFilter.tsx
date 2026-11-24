// The status switch at the top of every view: Active, Needs you, Done, Failed, All, each with its
// count, and a Today / 7 days / 30 days picker for Done and Failed.
import type { ItemRecord } from "@tokama/core";
import { type Filter, filterCounts, type Range, RANGES, STATUS_FILTERS, type StatusFilter as Status } from "../model.js";

const TEXT = { group: "Status filter", range: "Time range" } as const;

export interface StatusFilterProps {
  /** The items of the current view. */
  readonly items: readonly ItemRecord[];
  readonly filter: Filter;
  readonly now: number;
  readonly onChange: (patch: Partial<Filter>) => void;
}

export function StatusFilter({ items, filter, now, onChange }: StatusFilterProps) {
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
      {(filter.status === "done" || filter.status === "failed") && (
        <select className="range" aria-label={TEXT.range} value={filter.range} onChange={(event) => onChange({ range: event.target.value as Range })}>
          {RANGES.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
