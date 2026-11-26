// The sidebar's chip: a small pill button with an icon and a short line, such as "Updated to 0.2.1
// · fixes" or "Update". It is the one chip of the sidebar's chip slot at its foot: a chip hands
// the sidebar a candidate `{ id, priority, node: <Chip …/> }` (shell/sidebar-chip.ts), and the
// candidate with the highest priority shows (a ready update, 20, over the "Updated to" notice, 10).
// Chip icons are 13 px (CheckIcon, ShieldIcon, DownloadIcon at their defaults). The tone colours
// the icon: the link colour by default (something to open), `done` for something that went well,
// `attention` for something that needs a look, which also gives the border the warning colour. A
// version inside the children is a `mono` span. Colour is never the only signal: the icon and the
// words say the same. Like Button, it passes `ref`, `className`, `style`, `aria-*` and `data-*` on
// to the button, so a chip that needs a tooltip anchor or a popup trigger is still this one chip.
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "done" | "attention";
  /** The accessible name, when it differs from the text. */
  readonly label?: string;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Chip({ icon, children, tone, label, className, ref, ...rest }: ChipProps) {
  return (
    <button ref={ref} type="button" className={["chip", "rise-in", className].filter(Boolean).join(" ")} data-tone={tone} {...(label !== undefined && { "aria-label": label })} {...rest}>
      <span className="chip-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </button>
  );
}
