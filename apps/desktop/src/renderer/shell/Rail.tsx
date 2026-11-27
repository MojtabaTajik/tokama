// The icon rail: panel toggle, Board, Needs you, Insights, Settings, Attention, then the user.
// A mark on an icon means the user has to do something, never that something exists: a number on
// Needs you (1 to 9, then 9+), one "!" on any other icon. The reason is in the icon's name and its
// tooltip. Insights is the one usage entry: hovering or focusing it lists each AI CLI's plan
// limits, and clicking opens the Insights page; a "!" shows only while a limit is reached. Settings
// shows a "!" only while a crash report waits for an answer, and then opens on Diagnostics.
// Attention is in the rail only while something is broken, and opens a popup with the issues and
// how to fix them. A ready update shows above the user button while the sidebar is closed. The
// user button opens About. Needs you opens its page, Settings opens Settings.
import type { Setup, UsageReport } from "@tokama/core";
import { type CSSProperties, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { brand } from "../brand/index.js";
import { railBadge } from "../insights/usage-model.js";
import type { UpdateChipView } from "../../shared/update.js";
import { type CliIssue, type HealthProblem } from "../model.js";
import { UpdateRailIcon } from "../update/UpdateChip.js";
import { AttentionPopup, attentionName } from "./Attention.js";
import { InsightsTip } from "./InsightsTip.js";
import { Tooltip } from "../ui/Tooltip.js";
import { useHostTip, useTip } from "../ui/useTip.js";
import { AttentionIcon, BoardIcon, InboxIcon, InsightsIcon, PanelIcon, SettingsIcon, UserIcon } from "../ui/icons.js";
import { Button, type ButtonProps } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";

const TEXT = {
  rail: "App",
  panel: "Sidebar",
  board: "Board",
  needsYou: "Needs you",
  outOfDate: "out of date",
  insights: "Insights",
  usage: "Usage",
  settings: "Settings",
  attention: "Attention",
  crashWaiting: "Tokama stopped unexpectedly. Send the report?",
  about: "About Tokama",
} as const;

export interface RailProps {
  readonly panelOpen: boolean;
  /** The id of the sidebar, which the toggle controls while it is shown. */
  readonly panelId: string;
  readonly onTogglePanel: () => void;
  /** Items that need you; undefined when the count is out of date (the last load failed). */
  readonly needsYou: number | undefined;
  /** AI CLIs the engineer has to sign in to again. */
  readonly issues: readonly CliIssue[];
  /** Git and config problems; they count on Attention only. */
  readonly problems?: readonly HealthProblem[];
  /** Attention opened: the issues should be checked again. */
  readonly onAttention?: () => void;
  /** The plan windows the tooltip lists; undefined until loaded. */
  readonly usage?: UsageReport | undefined;
  readonly now?: number;
  /** The Insights page is the open view. */
  readonly insightsOpen?: boolean;
  readonly onInsights?: () => void;
  /** The tooltip opened (true) or closed (false): its numbers should be current while it shows. */
  readonly onInsightsTip?: (shown: boolean) => void;
  /** About is the open view; the Board button then leads back. */
  readonly aboutOpen: boolean;
  /** The Needs you page is the open view. */
  readonly needsYouOpen: boolean;
  readonly onBoard: () => void;
  readonly onNeedsYou: () => void;
  readonly onAbout: () => void;
  readonly onSettings: () => void;
  /** The setup: the tooltip names agents and shows Claude Code's login and version from it. */
  readonly setup?: Setup | undefined;
  /** An item in the tooltip's Today list was chosen. */
  readonly onSelectItem?: (itemId: string) => void;
  /** The tooltip's Settings link: the AI CLIs settings. */
  readonly onCliSettings?: () => void;
  /** A crash report waits for an answer and asking after a crash is on: Settings shows "!". */
  readonly crashWaiting?: boolean;
  /** A ready update, shown above the user button while the sidebar is closed (its chip shows there when it is open). */
  readonly update?: { readonly view: UpdateChipView; readonly onActivate: () => void; readonly onOpenNotes: () => void };
}

export { TIP_CLOSE_MS, TIP_OPEN_MS } from "../ui/useTip.js";

/** "Needs you · 2", or just "Needs you" when there are none. */
const withCount = (label: string, count: number) => (count > 0 ? `${label} · ${count}` : label);

/** "Settings · Tokama stopped unexpectedly. Send the report?": the icon's name, then the reason for its mark. */
const withCause = (label: string, cause: string | undefined) => (cause === undefined ? label : `${label} · ${cause}`);

/** A rail button whose name also shows in the shared tooltip, to its right, on hover and keyboard focus. */
function RailButton({ label, tipOff = false, children, ...props }: Omit<ButtonProps, "aria-label" | "title" | "variant" | "className"> & { readonly label: string; /** No tooltip now (the Attention popup is open). */ readonly tipOff?: boolean }) {
  const { ref, open } = useHostTip(!tipOff);
  const anchor = `--rail-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Button variant="plain" className="rail-button" aria-label={label} style={{ anchorName: anchor } as CSSProperties} {...props}>
      {children}
      <span ref={ref} hidden />
      {open && !tipOff && (
        <Tooltip id={`${anchor.slice(2)}-tip`} anchor={anchor} className="rail-tip" decorative>
          {label}
        </Tooltip>
      )}
    </Button>
  );
}

interface AttentionButtonProps {
  readonly issues: readonly CliIssue[];
  readonly problems: readonly HealthProblem[];
  /** The popup opened: the issues should be checked again. */
  readonly onOpen: (() => void) | undefined;
  /** Where the focus goes when the last issue is gone while it was on the button. */
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
}

/**
 * The Attention icon and its popup. The rail renders it only while something is broken, so the popup
 * (its state lives here) goes with the last issue, and so does the focus if it was on the button.
 */
function AttentionButton({ issues, problems, onOpen, returnFocus }: AttentionButtonProps) {
  const popupId = useId();
  const [popupOpen, setPopupOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setPopupOpen(false);
    // A press anywhere outside the Attention button and its popup closes the popup.
    const onPress = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setPopupOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPress);
    };
  }, []);
  // The cleanup runs before the button leaves the page, while the focus is still on it.
  useLayoutEffect(
    () => () => {
      if (wrapper.current?.contains(document.activeElement) === true) returnFocus.current?.focus();
    },
    [returnFocus],
  );
  const label = withCause(TEXT.attention, attentionName(issues, problems));
  return (
    <div className="attention" ref={wrapper}>
      <RailButton
        label={label}
        tipOff={popupOpen}
        data-tone="fail"
        aria-haspopup="dialog"
        aria-expanded={popupOpen}
        aria-controls={popupOpen ? popupId : undefined}
        onClick={() => {
          if (!popupOpen) onOpen?.();
          setPopupOpen(!popupOpen);
        }}
      >
        <AttentionIcon />
      </RailButton>
      {popupOpen && <AttentionPopup id={popupId} issues={issues} problems={problems} />}
    </div>
  );
}

export function Rail({ panelOpen, panelId, onTogglePanel, needsYou, issues, problems = [], onAttention, usage, now = Date.now(), insightsOpen = false, onInsights, onInsightsTip, aboutOpen, needsYouOpen, onBoard, onNeedsYou, onAbout, onSettings, setup, onSelectItem, onCliSettings, crashWaiting = false, update }: RailProps) {
  const tipId = useId();
  const attention = issues.length + problems.length;
  const boardButton = useRef<HTMLButtonElement>(null);
  // The Insights tooltip. Its own state, not a CSS :hover, decides when it shows: the wrapper holds
  // the button and the tooltip, so moving between them keeps it open, and short delays absorb the
  // enter and leave events a pointer sends at an edge, so it never flickers. Escape or a click
  // closes it until the pointer or the focus comes back. It stays closed while the Insights page is
  // open, which shows the same numbers.
  const tip = useTip(onInsightsTip, insightsOpen);
  const insightsButton = useRef<HTMLButtonElement>(null);
  // Closing the tooltip while focus is on one of its buttons hands focus back to Insights, so it
  // never falls to the page; an item drawer then also returns focus there when it closes.
  const closeTip = useCallback(() => {
    if (insightsButton.current?.parentElement?.contains(document.activeElement) === true) insightsButton.current.focus();
    tip.dismiss();
  }, [tip.dismiss]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeTip]);
  const limitCause = railBadge(usage, issues, now);
  const settingsLabel = withCause(TEXT.settings, crashWaiting ? TEXT.crashWaiting : undefined);
  const insightsLabel = withCause(TEXT.insights, limitCause);
  const needsYouLabel = needsYou === undefined ? `${TEXT.needsYou} · ${TEXT.outOfDate}` : withCount(TEXT.needsYou, needsYou);
  return (
    <nav className="rail" aria-label={TEXT.rail}>
      <img className="rail-mark" src={brand.mark32Url} alt={brand.name} width={22} height={22} />
      <Button
        variant="plain"
        className="rail-button"
        aria-label={TEXT.panel}
        title={TEXT.panel}
        aria-pressed={panelOpen}
        aria-controls={panelOpen ? panelId : undefined}
        onClick={onTogglePanel}
      >
        <PanelIcon />
      </Button>
      <Button variant="plain" className="rail-button" ref={boardButton} aria-label={TEXT.board} title={TEXT.board} aria-current={aboutOpen || needsYouOpen || insightsOpen ? undefined : "page"} onClick={onBoard}>
        <BoardIcon />
      </Button>
      <RailButton label={needsYouLabel} data-tone={needsYou !== undefined && needsYou > 0 ? "warn" : undefined} aria-current={needsYouOpen ? "page" : undefined} onClick={onNeedsYou}>
        <InboxIcon />
        <Badge count={needsYou ?? 0} tone="warn" />
      </RailButton>
      <div className="insights" data-open={tip.open || undefined} {...tip.triggers}>
        <Button
          variant="plain"
          className="rail-button"
          data-tone={limitCause === undefined ? undefined : "warn"}
          ref={insightsButton}
          aria-label={insightsLabel}
          aria-expanded={tip.open}
          aria-controls={tipId}
          aria-current={insightsOpen ? "page" : undefined}
          onClick={() => {
            tip.dismiss();
            onInsights?.();
          }}
        >
          <InsightsIcon />
          {limitCause !== undefined && <Badge count={1} tone="warn" symbol="!" />}
        </Button>
        <div role="group" aria-label={TEXT.usage} id={tipId} className="tooltip insights-tip">
          <div className="it-scroll">
            <InsightsTip
            cause={limitCause}
            usage={usage}
            issues={issues}
            health={setup?.health.clis}
            setup={setup}
            now={now}
            onSelectItem={(itemId) => {
              closeTip();
              onSelectItem?.(itemId);
            }}
            onCliSettings={() => {
              closeTip();
              onCliSettings?.();
            }}
            />
          </div>
        </div>
      </div>
      <RailButton label={settingsLabel} onClick={onSettings}>
        <SettingsIcon />
        {crashWaiting && <Badge count={1} tone="warn" symbol="!" />}
      </RailButton>
      {attention > 0 && <AttentionButton issues={issues} problems={problems} onOpen={onAttention} returnFocus={boardButton} />}
      <div className="rail-spacer" />
      {update !== undefined && <UpdateRailIcon view={update.view} onActivate={update.onActivate} onOpenNotes={update.onOpenNotes} />}
      <Button variant="plain" className="rail-user" aria-label={TEXT.about} title={TEXT.about} aria-current={aboutOpen ? "page" : undefined} onClick={onAbout}>
        <UserIcon />
      </Button>
    </nav>
  );
}

