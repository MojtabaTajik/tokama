// The ready update at the foot of the sidebar as a chip, and in the collapsed rail as an icon. Both
// show a tooltip on hover and on keyboard focus (Escape closes it), and a click on either always
// opens the same small panel: the version, why it matters, what runs, What's new, Not now and
// Restart now. A click alone never restarts; Restart now is a second, clear button, and it is off
// while items run. Tokama never restarts by itself. While the restart is under way the chip is a
// status line. Release text (the reason) is rendered as React text only.
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef } from "react";
import { CANT_TELL, NOTHING_RUNNING, RESTARTING, RESTART_NOW_BLOCKED, RESTART_TOKAMA, STALLED, STALLED_ACTION, type UpdateChipView, updatePanelText } from "../../shared/update.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Chip } from "../ui/Chip.js";
import { DownloadIcon, WarningIcon } from "../ui/icons.js";
import { StatusMark } from "../ui/status.js";
import { Tooltip } from "../ui/Tooltip.js";
import { useTip } from "../ui/useTip.js";

const TEXT = {
  panel: "Update",
  later: "Not now",
  now: "Restart now",
} as const;

/** An item that runs now, as the panel lists it. */
export interface RunningItem {
  readonly id: string;
  readonly title: string;
  /** The template's name. */
  readonly template: string;
}

export interface UpdateChipProps {
  readonly view: UpdateChipView;
  readonly running: readonly RunningItem[];
  /** The engine refused the restart: it runs items the window does not list (`running` says how many), or would not say. */
  readonly busy?: { readonly running?: number } | undefined;
  readonly panelOpen: boolean;
  /** A click on the chip. */
  readonly onActivate: () => void;
  /** Restart now in the panel; the panel only offers it while nothing runs. */
  readonly onRestartNow: () => void;
  readonly onClosePanel: () => void;
  /** The tooltip's link: the notes of this version. */
  readonly onOpenNotes: () => void;
}

/** The tooltip's open state, with Escape closing it and giving the focus back to the button. */
function useUpdateTip(suppressed: boolean) {
  const tip = useTip(undefined, suppressed);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const { open, dismiss } = tip;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (wrapper.current?.contains(document.activeElement) === true) button.current?.focus();
      dismiss();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [open, dismiss]);
  return { ...tip, button, wrapper };
}

function UpdateTip({ id, anchor, view, placement, onOpenNotes }: { readonly id: string; readonly anchor: string; readonly view: UpdateChipView; readonly placement: "above" | "right"; readonly onOpenNotes: () => void }) {
  return (
    <Tooltip id={id} anchor={anchor} className={placement === "above" ? "up-tip up-tip-above" : "up-tip up-tip-right"}>
      <span className="up-tip-title" data-critical={view.critical || undefined}>
        {view.critical && <WarningIcon size={13} />}
        <span>{view.title}</span>
      </span>
      {view.reason !== undefined && <span className="up-tip-reason">{view.reason}</span>}
      <span className="up-tip-action">{view.action}</span>
      <Button variant="link" className="up-tip-link" onClick={onOpenNotes}>
        What's new in <span className="mono">{view.version}</span>
      </Button>
    </Tooltip>
  );
}

/** The chip for the sidebar's foot. */
export function UpdateChip({ view, running, busy, panelOpen, onActivate, onRestartNow, onClosePanel, onOpenNotes }: UpdateChipProps) {
  const tipId = useId();
  const anchor = "--update-chip";
  const showPanel = panelOpen && view.kind === "ready";
  const tip = useUpdateTip(showPanel);

  // Escape or a press outside closes the panel.
  useEffect(() => {
    if (!showPanel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      tip.button.current?.focus();
      onClosePanel();
    };
    const onPress = (event: MouseEvent) => {
      if (tip.wrapper.current?.contains(event.target as Node) !== true) onClosePanel();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    document.addEventListener("mousedown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey, { capture: true });
      document.removeEventListener("mousedown", onPress);
    };
  }, [showPanel, onClosePanel, tip.button, tip.wrapper]);

  if (view.kind === "stalled") {
    // The installer did not answer: say so, and let the user ask it again.
    return (
      <div role="status" className="up-stalled">
        <span className="up-stalled-text">
          {STALLED}. {STALLED_ACTION}
        </span>
        <Button variant="secondary" onClick={onRestartNow}>
          {RESTART_TOKAMA}
        </Button>
      </div>
    );
  }
  if (view.kind === "installing") {
    return (
      <span role="status" className="chip up-status">
        <StatusMark status="running" className="up-status-dot" />
        {RESTARTING}
      </span>
    );
  }
  return (
    <div ref={tip.wrapper} className="up" {...tip.triggers}>
      <Chip
        ref={tip.button}
        className="up-chip"
        icon={view.critical ? <WarningIcon size={13} /> : <DownloadIcon />}
        {...(view.critical && { tone: "attention" as const })}
        data-critical={view.critical || undefined}
        data-ring=""
        aria-label={view.accessibleName}
        aria-haspopup="dialog"
        aria-expanded={showPanel}
        aria-describedby={tip.open ? tipId : undefined}
        style={{ anchorName: anchor } as CSSProperties}
        onClick={() => {
          tip.dismiss();
          onActivate();
        }}
      >
        {view.label}
      </Chip>
      {tip.open && !showPanel && <UpdateTip id={tipId} anchor={anchor} view={view} placement="above" onOpenNotes={onOpenNotes} />}
      {showPanel && <UpdatePanel anchor={anchor} view={view} running={running} busy={busy} onRestartNow={onRestartNow} onClose={onClosePanel} onOpenNotes={onOpenNotes} />}
    </div>
  );
}

interface UpdatePanelProps {
  readonly anchor: string;
  readonly view: UpdateChipView;
  readonly running: readonly RunningItem[];
  readonly busy: { readonly running?: number } | undefined;
  readonly onRestartNow: () => void;
  readonly onClose: () => void;
  readonly onOpenNotes: () => void;
}

/** What a click on the chip opens: the version, why it matters, what runs, and a clear Restart now. */
function UpdatePanel({ anchor, view, running, busy, onRestartNow, onClose, onOpenNotes }: UpdatePanelProps) {
  const ref = useRef<HTMLElement>(null);
  const whyId = useId();
  // In the top layer, so the scrolling sidebar does not clip it.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element?.isConnected !== true || typeof element.showPopover !== "function") return;
    element.showPopover();
  }, []);
  // The window lists no running item, but the engine refused: it runs some (a count) or would not say.
  const unlisted = running.length === 0 && busy !== undefined;
  const count = running.length > 0 ? running.length : (busy?.running ?? 0);
  const blocked = running.length > 0 || busy !== undefined;
  const text = !blocked ? NOTHING_RUNNING : unlisted && count === 0 ? CANT_TELL : updatePanelText(count);
  return (
    <section ref={ref} role="dialog" aria-label={TEXT.panel} popover="manual" className="up-panel" style={{ positionAnchor: anchor } as CSSProperties}>
      <span className="up-tip-title" data-critical={view.critical || undefined}>
        {view.critical && <WarningIcon size={13} />}
        <span>{view.title}</span>
      </span>
      {view.reason !== undefined && <span className="up-panel-text">{view.reason}</span>}
      <span className="up-panel-text">{text}</span>
      {running.length > 0 && (
        <ul className="up-panel-items">
          {running.map((item) => (
            <li key={item.id}>
              <StatusMark status="running" className="up-panel-mark" />
              <span className="ellipsis">
                {item.title} <span className="up-panel-template">· {item.template}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button variant="link" className="up-tip-link" onClick={onOpenNotes}>
        What's new in <span className="mono">{view.version}</span>
      </Button>
      <div className="up-panel-actions">
        <Button variant="secondary" onClick={onClose}>
          {TEXT.later}
        </Button>
        <Button variant={blocked ? "secondary" : "primary"} aria-disabled={blocked || undefined} aria-describedby={whyId} onClick={() => !blocked && onRestartNow()}>
          {TEXT.now}
        </Button>
      </div>
      <span id={whyId} className="up-panel-why">
        {RESTART_NOW_BLOCKED}
      </span>
    </section>
  );
}

export interface UpdateRailIconProps {
  readonly view: UpdateChipView;
  readonly onActivate: () => void;
  readonly onOpenNotes: () => void;
}

/** The collapsed rail's update icon: the download icon with a dot, or the warning icon with a "!" badge. */
export function UpdateRailIcon({ view, onActivate, onOpenNotes }: UpdateRailIconProps) {
  const tipId = useId();
  const anchor = "--update-rail";
  const tip = useUpdateTip(false);
  if (view.kind === "installing") return null;
  // An update that did not install asks for a look as much as an important one does.
  const alert = view.critical || view.kind === "stalled";
  return (
    <div ref={tip.wrapper} className="up-rail" {...tip.triggers}>
      <Button
        variant="plain"
        ref={tip.button}
        className="rail-button up-rail-button"
        data-critical={alert || undefined}
        data-ring=""
        aria-label={view.accessibleName}
        aria-describedby={tip.open ? tipId : undefined}
        style={{ anchorName: anchor } as CSSProperties}
        onClick={() => {
          tip.dismiss();
          onActivate();
        }}
      >
        {alert ? <WarningIcon /> : <DownloadIcon size={18} />}
        {alert ? <Badge count={1} tone="warn" symbol="!" /> : <span aria-hidden="true" className="up-dot" />}
      </Button>
      {tip.open && <UpdateTip id={tipId} anchor={anchor} view={view} placement="right" onOpenNotes={onOpenNotes} />}
    </div>
  );
}
