// A link to a page outside the app, which opens in the system browser. The main process opens
// only the few addresses it lists, so a link here must be one of them. It ends in ↗, so it reads
// as leaving the app without relying on colour. With a `variant` it looks like that button.
import type { ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "./Button.js";

export interface ExternalLinkProps {
  readonly href: string;
  readonly variant?: ButtonVariant | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function ExternalLink({ href, variant, className, children }: ExternalLinkProps) {
  const classes = variant === undefined ? ["ext-link", className] : [buttonClass(variant, undefined, undefined), "ext-link", "ext-link-button", className];
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={classes.filter(Boolean).join(" ")}>
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
