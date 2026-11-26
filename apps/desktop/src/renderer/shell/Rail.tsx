// The icon rail: panel toggle, Board, Needs you, Insights, Settings, Attention, then the user.
// Insights is the one usage entry: hovering or focusing it lists each AI CLI's plan limits, and
// clicking opens the Insights page. A CLI that is logged out or at its limit puts a ✕ on the icon,
// one near its limit a !. A ready update shows above the user button while the sidebar is closed. Settings counts the diagnostics entries waiting to be sent. Attention
// opens a popup with the issues and how to fix them. The user
// button opens About. Needs you opens its page, Settings opens Settings.
import type { Setup, UsageReport } from "@tokama/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { brand } from "../brand/index.js";
import { cliAlert, railBadge } from "../insights/usage-model.js";
import type { UpdateChipView } from "../../shared/update.js";
import { AI_CLIS, type CliIssue, type HealthProblem } from "../model.js";
import { UpdateRailIcon } from "../update/UpdateChip.js";
import { AttentionPopup } from "./Attention.js";
import { InsightsTip } from "./InsightsTip.js";
import { useTip } from "../ui/useTip.js";
import { AttentionIcon, BoardIcon, InboxIcon, InsightsIcon, PanelIcon, SettingsIcon, UserIcon } from "../ui/icons.js";
import { Button } from "../ui/Button.js";
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
  diagnosticsWaiting: "diagnostics waiting",
  attention: "Attention",
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
  /** Diagnostics entries waiting to be sent; they count on Settings. */
  readonly diagnosticsWaiting?: number;
  /** A ready update, shown above the user button while the sidebar is closed (its chip shows there when it is open). */
  readonly update?: { readonly view: UpdateChipView; readonly onActivate: () => void; readonly onOpenNotes: () => void };
}

export { TIP_CLOSE_MS, TIP_OPEN_MS } from "../ui/useTip.js";

/** "Needs you · 2", or just "Needs you" when there are none. */
const withCount = (label: string, count: number) => (count > 0 ? `${label} · ${count}` : label);

export function Rail({ panelOpen, panelId, onTogglePanel, needsYou, issues, problems = [], onAttention, usage, now = Date.now(), insightsOpen = false, onInsights, onInsightsTip, aboutOpen, needsYouOpen, onBoard, onNeedsYou, onAbout, onSettings, setup, onSelectItem, onCliSettings, diagnosticsWaiting = 0, update }: RailProps) {
  const tipId = useId();
  const popupId = useId();
  const attention = issues.length + problems.length;
  const [popupOpen, setPopupOpen] = useState(false);
  const attentionRef = useRef<HTMLDivElement>(null);
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
      if (event.key === "Escape") {
        closeTip();
        setPopupOpen(false);
      }
    };
    // A press anywhere outside the Attention button and its popup closes the popup.
    const onPress = (event: MouseEvent) => {
      if (!attentionRef.current?.contains(event.target as Node)) setPopupOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPress);
    };
  }, [closeTip]);
  const badge = railBadge(AI_CLIS.map((cli) => cliAlert(usage?.clis.find((plan) => plan.cliId === cli.id), issues.find((issue) => issue.cliId === cli.id), now)));
  const settingsLabel = diagnosticsWaiting > 0 ? `${TEXT.settings} · ${diagnosticsWaiting > 99 ? "99+" : diagnosticsWaiting} ${TEXT.diagnosticsWaiting}` : TEXT.settings;
  const needsYouLabel = needsYou === undefined ? `${TEXT.needsYou} · ${TEXT.outOfDate}` : withCount(TEXT.needsYou, needsYou);
  return (
    <nav className="rail" aria-label={TEXT.rail}>
      <img className="rail-mark" src={brand.markUrl} alt={brand.name} width={22} height={22} />
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
      <Button variant="plain" className="rail-button" aria-label={TEXT.board} title={TEXT.board} aria-current={aboutOpen || needsYouOpen || insightsOpen ? undefined : "page"} onClick={onBoard}>
        <BoardIcon />
      </Button>
      <Button
        variant="plain"
        className="rail-button"
        data-tone={needsYou !== undefined && needsYou > 0 ? "warn" : undefined}
        aria-label={needsYouLabel}
        title={needsYouLabel}
        aria-current={needsYouOpen ? "page" : undefined}
        onClick={onNeedsYou}
      >
        <InboxIcon />
        <Badge count={needsYou ?? 0} tone="warn" />
      </Button>
      <div className="insights" data-open={tip.open || undefined} {...tip.triggers}>
        <Button
          variant="plain"
          className="rail-button"
          data-tone={badge?.tone}
          ref={insightsButton}
          aria-label={TEXT.insights}
          aria-expanded={tip.open}
          aria-controls={tipId}
          aria-current={insightsOpen ? "page" : undefined}
          onClick={() => {
            tip.dismiss();
            onInsights?.();
          }}
        >
          <InsightsIcon />
          {badge !== undefined && <Badge count={1} tone={badge.tone} symbol={badge.symbol} />}
        </Button>
        <div role="group" aria-label={TEXT.usage} id={tipId} className="tooltip insights-tip">
          <div className="it-scroll">
            <InsightsTip
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
      <Button variant="plain" className="rail-button" aria-label={settingsLabel} title={settingsLabel} onClick={onSettings}>
        <SettingsIcon />
        <Badge count={diagnosticsWaiting} tone="neutral" />
      </Button>
      <div className="attention" ref={attentionRef}>
        <Button
          variant="plain"
          className="rail-button"
          data-tone={attention > 0 ? "fail" : undefined}
          aria-label={withCount(TEXT.attention, attention)}
          title={withCount(TEXT.attention, attention)}
          aria-haspopup="dialog"
          aria-expanded={popupOpen}
          aria-controls={popupOpen ? popupId : undefined}
          onClick={() => {
            if (!popupOpen) onAttention?.();
            setPopupOpen(!popupOpen);
          }}
        >
          <AttentionIcon />
          <Badge count={attention} tone="fail" />
        </Button>
        {popupOpen && <AttentionPopup id={popupId} issues={issues} problems={problems} />}
      </div>
      <div className="rail-spacer" />
      {update !== undefined && <UpdateRailIcon view={update.view} onActivate={update.onActivate} onOpenNotes={update.onOpenNotes} />}
      <Button variant="plain" className="rail-user" aria-label={TEXT.about} title={TEXT.about} aria-current={aboutOpen ? "page" : undefined} onClick={onAbout}>
        <UserIcon />
      </Button>
    </nav>
  );
}

