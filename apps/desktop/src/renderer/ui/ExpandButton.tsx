// The icon button that opens something in the full main area (⤢), or brings it back (⤡).
import { Button, type ButtonProps } from "./Button.js";
import { CollapseIcon, ExpandIcon } from "./icons.js";

export interface ExpandButtonProps extends Omit<ButtonProps, "variant" | "size" | "children"> {
  /** What pressing it does, for screen readers and as a tooltip: "Open full view". */
  readonly label: string;
  /** The tooltip when it says more than the label, such as the key that does the same. */
  readonly tip?: string | undefined;
  readonly collapse?: boolean;
}

export function ExpandButton({ label, tip = label, collapse = false, ...rest }: ExpandButtonProps) {
  return (
    <Button variant="quiet" size="icon" aria-label={label} title={tip} {...rest}>
      {collapse ? <CollapseIcon /> : <ExpandIcon />}
    </Button>
  );
}
