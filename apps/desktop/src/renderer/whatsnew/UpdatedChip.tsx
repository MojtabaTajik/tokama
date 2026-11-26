// The "Updated to 0.2.1 · fixes" chip, for an update whose notes have no highlights. It shows for a
// few seconds in the sidebar's chip slot and is a one-time notice: the main process is told as it
// first shows, so quitting within those seconds does not bring it back. Leaving the screen (the
// sidebar closes, Settings opens) also ends it. A click opens About on this version.
import { useEffect, useRef } from "react";
import { Chip } from "../ui/Chip.js";
import { CheckIcon, ShieldIcon } from "../ui/icons.js";
import { TEXT } from "./words.js";

/** How long the chip stays. */
export const CHIP_MS = 6_000;

export interface UpdatedChipProps {
  readonly version: string;
  readonly kind: "fixes" | "security";
  /** The chip is on screen. */
  readonly onShown: () => void;
  /** The chip is over: its time ran out, it was clicked, or it left the screen. */
  readonly onGone: () => void;
  /** Opens About on this version. */
  readonly onOpen: () => void;
  /** For tests: how long it stays. */
  readonly ms?: number;
}

export function UpdatedChip({ version, kind, onShown, onGone, onOpen, ms = CHIP_MS }: UpdatedChipProps) {
  const latest = useRef({ onShown, onGone });
  latest.current = { onShown, onGone };
  useEffect(() => {
    latest.current.onShown();
    const timer = setTimeout(() => latest.current.onGone(), ms);
    return () => {
      clearTimeout(timer);
      latest.current.onGone();
    };
  }, [version, ms]);
  const security = kind === "security";
  return (
    <Chip
      tone="done"
      icon={security ? <ShieldIcon size={13} /> : <CheckIcon />}
      {...(security && { title: TEXT.securityLine })}
      onClick={() => {
        onGone();
        onOpen();
      }}
    >
      <span>
        {TEXT.updatedTo} <span className="mono">{version}</span> · {security ? TEXT.chipSecurity : TEXT.chipFixes}
      </span>
    </Chip>
  );
}
