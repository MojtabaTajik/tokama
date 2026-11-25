// A tooltip in the top layer, so no scrolling list or drawer around its trigger clips it. It is
// placed by the trigger's CSS anchor name; where the browser has no popovers it is a plain
// element. useTip decides when it shows.
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from "react";

export interface TooltipProps {
  readonly id: string;
  /** The dashed ident the trigger carries as its anchor-name. */
  readonly anchor: string;
  /** The screen's class for the tooltip's width and layout. */
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function Tooltip({ id, anchor, className, children }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element?.isConnected !== true || typeof element.showPopover !== "function") return;
    element.showPopover();
  }, []);
  return (
    <div ref={ref} id={id} role="tooltip" popover="manual" className={["tooltip", className].filter(Boolean).join(" ")} style={{ positionAnchor: anchor } as CSSProperties}>
      {children}
    </div>
  );
}
