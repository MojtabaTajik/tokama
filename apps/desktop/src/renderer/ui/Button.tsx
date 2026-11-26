// The app's one button. Variants: primary (the main action), secondary (an outlined action),
// danger (an action that ends or removes something), link (text in the link colour), quiet (text
// that brightens on hover) and plain (no chrome at all, for rows, cards and other buttons that
// draw themselves). Sizes: sm, md (default) and lg for the outlined variants, and icon for a
// square button that shows only an icon and so needs an aria-label. A screen's own class only
// places the button; it never restyles it.
import type { ButtonHTMLAttributes, Ref } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "link" | "quiet" | "plain";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize | undefined;
  /** A link inside running text, or a quiet button next to a control: always underlined (dotted when quiet), so colour is not its only signal. */
  readonly inline?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** The classes a button gets: `btn`, its variant, its size, then the screen's own. */
export function buttonClass(variant: ButtonVariant, size: ButtonSize | undefined, className: string | undefined): string {
  return ["btn", `btn-${variant}`, size === undefined ? undefined : `btn-${size}`, className].filter(Boolean).join(" ");
}

export function Button({ variant = "secondary", size, inline = false, className, type = "button", ref, ...rest }: ButtonProps) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} data-inline={inline || undefined} {...rest} />;
}

export interface CloseButtonProps extends Omit<ButtonProps, "variant" | "size" | "children"> {
  /** What closing does, for screen readers: "Close", "Clear search". */
  readonly label?: string;
  /** A square icon button, or `inline`: just the ✕, for a chip or a line of text. */
  readonly size?: "icon" | "icon-sm" | "inline";
}

/** ✕ with an aria-label and a matching tooltip. */
export function CloseButton({ label = "Close", size = "icon", ...rest }: CloseButtonProps) {
  return (
    <Button variant="quiet" size={size === "inline" ? undefined : size} aria-label={label} title={label} {...rest}>
      <span aria-hidden="true">✕</span>
    </Button>
  );
}
