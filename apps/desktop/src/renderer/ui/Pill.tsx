// A small outlined label: what a template uses, a command it may run, a plan name, an agent's
// owner. Text only, never a button. `accent` marks a known or chosen value in the link colour;
// `round` is the fully rounded form for a label next to a heading.
import type { ReactNode } from "react";

export interface PillProps {
  readonly children: ReactNode;
  readonly tone?: "accent" | undefined;
  readonly round?: boolean;
  /** `code` for a command or a path. */
  readonly as?: "span" | "code";
  readonly className?: string | undefined;
}

export function Pill({ children, tone, round = false, as: Tag = "span", className }: PillProps) {
  return (
    <Tag className={["pill", className].filter(Boolean).join(" ")} data-tone={tone} data-round={round || undefined}>
      {children}
    </Tag>
  );
}
