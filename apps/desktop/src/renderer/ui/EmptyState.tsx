// What a screen shows in place of its content. EmptyState: nothing here yet, with a title, a line
// on what to do and maybe an icon and an action. Placeholder: one quiet line while something
// loads, or where a short list has nothing in it.
import type { ReactNode } from "react";

export interface EmptyStateProps {
  readonly title: string;
  /** One line on what to do; richer content goes in `children`. */
  readonly text?: string | undefined;
  readonly icon?: ReactNode;
  /** A button under the text. */
  readonly action?: ReactNode;
  /** The screen's class for where the state sits: centred in a pane, in a box, near the top. */
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}

export function EmptyState({ title, text, icon, action, className, children }: EmptyStateProps) {
  return (
    <section className={["empty-state", className].filter(Boolean).join(" ")} aria-label={title}>
      {icon !== undefined && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="empty-state-title">{title}</h2>
      {text !== undefined && <p className="empty-state-text">{text}</p>}
      {children}
      {action}
    </section>
  );
}

export function Placeholder({ children }: { readonly children: ReactNode }) {
  return <p className="placeholder">{children}</p>;
}
