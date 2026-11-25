// The inner edge of a resizable panel: a separator that the pointer drags and the keyboard moves.
// While dragging it shows the width. A double-click, or Enter, resets the panel to its default.
// `onChange` runs on every step; `onCommit` once when a drag, a key press or a reset is done, so
// the caller saves once.
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

/** One arrow key press moves the edge by this many px. */
export const KEY_STEP = 16;

export interface ResizeEdgeProps {
  readonly label: string;
  readonly side: "sidebar" | "drawer";
  /** The width shown now. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  /** 1 when moving the edge to the right widens the panel (the sidebar), -1 when it narrows it (the drawer). */
  readonly grow: 1 | -1;
  readonly onChange: (width: number) => void;
  readonly onCommit: (width: number) => void;
}

export function ResizeEdge({ label, side, value, min, max, defaultValue, grow, onChange, onCommit }: ResizeEdgeProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ readonly x: number; readonly from: number; width: number } | undefined>(undefined);
  const clamp = (width: number) => Math.min(max, Math.max(min, Math.round(width)));
  const set = (width: number) => {
    onChange(width);
    onCommit(width);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // No text selection while dragging; the focus still moves to the edge.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, from: value, width: value };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === undefined) return;
    start.width = clamp(start.from + grow * (event.clientX - start.x));
    onChange(start.width);
  };
  const end = () => {
    const start = drag.current;
    if (start === undefined) return;
    drag.current = undefined;
    setDragging(false);
    onCommit(start.width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? KEY_STEP : event.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (step !== 0) set(clamp(value + grow * step));
    else if (event.key === "Home") set(min);
    else if (event.key === "End") set(max);
    else if (event.key === "Enter") set(defaultValue);
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} px`}
      tabIndex={0}
      className={`resize-edge resize-edge-${side}`}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => set(defaultValue)}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden="true" className="resize-line" />
      <span aria-hidden="true" className="resize-grip">
        ⇔
      </span>
      {dragging ? (
        <span aria-hidden="true" className="resize-label">
          {value} px
        </span>
      ) : null}
    </div>
  );
}
