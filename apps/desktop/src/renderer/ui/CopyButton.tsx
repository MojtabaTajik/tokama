// A button that copies and says how it went: "✓ Copied" or "Could not copy" for two seconds, then
// its label again. The screen says what to copy and how (the clipboard, or the main process).
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button.js";

/** How long "Copied" or "Could not copy" shows. */
export const COPIED_FOR_MS = 2000;

/** Text to the system clipboard; no clipboard at all (an old or locked-down runtime) is a failed copy. */
export const toClipboard = (text: string) => () => Promise.resolve().then(() => navigator.clipboard.writeText(text));

export interface CopyButtonProps {
  /** Does the copy; a rejection reads as a failed copy. */
  readonly copy: () => Promise<unknown>;
  readonly label?: string;
  /** Names the button for assistive tech when the label alone ("Copy") does not say what it copies. */
  readonly ariaLabel?: string | undefined;
  /** Shown before the label while it reads as the label. */
  readonly icon?: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize | undefined;
  readonly className?: string | undefined;
  readonly disabled?: boolean;
}

export function CopyButton({ copy, label = "Copy", ariaLabel, icon, variant = "secondary", size, className, disabled }: CopyButtonProps) {
  const [done, setDone] = useState<"copied" | "failed" | undefined>(undefined);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const onClick = async () => {
    const copied = await copy().then(
      () => true,
      () => false,
    );
    setDone(copied ? "copied" : "failed");
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setDone(undefined), COPIED_FOR_MS);
  };
  return (
    <Button variant={variant} size={size} className={className} disabled={disabled} aria-label={done === undefined ? ariaLabel : undefined} onClick={() => void onClick()}>
      {done === "copied" ? (
        <>
          <span aria-hidden="true">✓</span> Copied
        </>
      ) : done === "failed" ? (
        "Could not copy"
      ) : (
        <>
          {icon}
          {label}
        </>
      )}
    </Button>
  );
}
