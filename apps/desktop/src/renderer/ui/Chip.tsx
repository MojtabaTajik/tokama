// The sidebar's chip: a small pill button with an icon and a short line, such as "Updated to 0.2.1
// · fixes". It sits in the one chip slot at the foot of the sidebar (shell/sidebar-chip.ts picks
// which chip shows). The tone colours the icon: the link colour by default (something to open), `done`
// for something that went well, `attention` for something that needs a look, which also gives the
// border the warning colour. A version inside the children is a `mono` span. Colour is never the
// only signal: the icon and the words say the same.
import type { ReactNode } from "react";

export interface ChipProps {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "done" | "attention";
  readonly onClick: () => void;
  /** The accessible name, when it differs from the text. */
  readonly label?: string;
  readonly title?: string;
}

export function Chip({ icon, children, tone, onClick, label, title }: ChipProps) {
  return (
    <button type="button" className="chip rise-in" data-tone={tone} aria-label={label} title={title} onClick={onClick}>
      <span className="chip-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </button>
  );
}
