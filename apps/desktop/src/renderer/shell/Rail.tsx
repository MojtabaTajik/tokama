// The icon rail: panel toggle, Board, Needs you, Insights, Settings, Attention, then the user.
// Insights is the one usage entry: hovering or focusing it lists each AI CLI, and a logged-out one
// puts a ✕ on the icon. Attention opens a popup with the issues and how to fix them. The user
// button opens About. The other buttons are marked aria-disabled until their screens exist.
import { useEffect, useId, useRef, useState } from "react";
import { brand } from "../brand/index.js";
import { AI_CLIS, type CliIssue } from "../model.js";
import { AttentionPopup } from "./Attention.js";
import { AttentionIcon, BoardIcon, InboxIcon, InsightsIcon, PanelIcon, SettingsIcon, UserIcon } from "./icons.js";

const TEXT = {
  rail: "App",
  panel: "Sidebar",
  board: "Board",
  needsYou: "Needs you",
  outOfDate: "out of date",
  insights: "Insights",
  settings: "Settings",
  attention: "Attention",
  usageLater: "usage data comes later",
  loggedOut: "✕ logged out",
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
  /** About is the open view; the Board button then leads back. */
  readonly aboutOpen: boolean;
  readonly onBoard: () => void;
  readonly onAbout: () => void;
}

/** "Needs you · 2", or just "Needs you" when there are none. */
const withCount = (label: string, count: number) => (count > 0 ? `${label} · ${count}` : label);

export function Rail({ panelOpen, panelId, onTogglePanel, needsYou, issues, aboutOpen, onBoard, onAbout }: RailProps) {
  const tipId = useId();
  const popupId = useId();
  const attention = issues.length;
  const [popupOpen, setPopupOpen] = useState(false);
  const attentionRef = useRef<HTMLDivElement>(null);
  // Escape closes the tooltip while the pointer or focus stays on Insights; leaving brings it back.
  const [tipDismissed, setTipDismissed] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTipDismissed(true);
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
  }, []);
  const needsYouLabel = needsYou === undefined ? `${TEXT.needsYou} · ${TEXT.outOfDate}` : withCount(TEXT.needsYou, needsYou);
  return (
    <nav className="rail" aria-label={TEXT.rail}>
      <img className="rail-mark" src={brand.markUrl} alt={brand.name} width={22} height={22} />
      <button
        type="button"
        className="rail-button"
        aria-label={TEXT.panel}
        title={TEXT.panel}
        aria-pressed={panelOpen}
        aria-controls={panelOpen ? panelId : undefined}
        onClick={onTogglePanel}
      >
        <PanelIcon />
      </button>
      <button type="button" className="rail-button" aria-label={TEXT.board} title={TEXT.board} aria-current={aboutOpen ? undefined : "page"} onClick={onBoard}>
        <BoardIcon />
      </button>
      <button
        type="button"
        className="rail-button"
        data-tone={needsYou !== undefined && needsYou > 0 ? "warn" : undefined}
        aria-label={needsYouLabel}
        title={needsYouLabel}
        aria-disabled="true"
      >
        <InboxIcon />
        <Badge count={needsYou ?? 0} tone="warn" />
      </button>
      <div className="insights" data-dismissed={tipDismissed || undefined} onMouseEnter={() => setTipDismissed(false)} onMouseLeave={() => setTipDismissed(false)} onFocus={() => setTipDismissed(false)}>
        <button type="button" className="rail-button" data-tone={issues.length > 0 ? "fail" : undefined} aria-label={TEXT.insights} aria-describedby={tipId} aria-disabled="true">
          <InsightsIcon />
          <Badge count={issues.length} tone="fail" symbol="✕" />
        </button>
        <div role="tooltip" id={tipId} className="insights-tip">
          <p className="insights-title">{TEXT.insights}</p>
          <ul>
            {AI_CLIS.map((cli) => (
              <li key={cli.id}>
                <span>{cli.name}</span>
                <span className="insights-state">{issues.some((issue) => issue.cliId === cli.id) ? TEXT.loggedOut : TEXT.usageLater}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <button type="button" className="rail-button" aria-label={TEXT.settings} title={TEXT.settings} aria-disabled="true">
        <SettingsIcon />
      </button>
      <div className="attention" ref={attentionRef}>
        <button
          type="button"
          className="rail-button"
          data-tone={attention > 0 ? "fail" : undefined}
          aria-label={withCount(TEXT.attention, attention)}
          title={withCount(TEXT.attention, attention)}
          aria-haspopup="dialog"
          aria-expanded={popupOpen}
          aria-controls={popupOpen ? popupId : undefined}
          onClick={() => setPopupOpen(!popupOpen)}
        >
          <AttentionIcon />
          <Badge count={attention} tone="fail" />
        </button>
        {popupOpen && <AttentionPopup id={popupId} issues={issues} />}
      </div>
      <div className="rail-spacer" />
      <button type="button" className="rail-user" aria-label={TEXT.about} title={TEXT.about} aria-current={aboutOpen ? "page" : undefined} onClick={onAbout}>
        <UserIcon />
      </button>
    </nav>
  );
}

/** A count on a button, or `symbol` instead of the number when the kind matters more than how many. */
function Badge({ count, tone, symbol }: { readonly count: number; readonly tone: "warn" | "fail"; readonly symbol?: string }) {
  if (count <= 0) return null;
  return (
    <span className="badge" data-tone={tone} aria-hidden="true">
      {symbol ?? (count > 99 ? "99+" : count)}
    </span>
  );
}
