// The icon rail: panel toggle, Board, Needs you, Insights, Settings, Attention, then the user.
// Insights is the one usage entry: hovering or focusing it lists each AI CLI. Only the panel
// toggle acts for now; the other buttons are marked aria-disabled until their screens exist.
import { useId } from "react";
import { brand } from "../brand/index.js";
import { AI_CLIS } from "../model.js";
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
  user: "You",
} as const;

export interface RailProps {
  readonly panelOpen: boolean;
  /** The id of the sidebar, which the toggle controls while it is shown. */
  readonly panelId: string;
  readonly onTogglePanel: () => void;
  /** Items that need you; undefined when the count is out of date (the last load failed). */
  readonly needsYou: number | undefined;
  /** Health issues (expiring token, quota, a host's model server down). None are reported yet. */
  readonly attention: number;
}

/** "Needs you · 2", or just "Needs you" when there are none. */
const withCount = (label: string, count: number) => (count > 0 ? `${label} · ${count}` : label);

export function Rail({ panelOpen, panelId, onTogglePanel, needsYou, attention }: RailProps) {
  const tipId = useId();
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
      <button type="button" className="rail-button" aria-label={TEXT.board} title={TEXT.board} aria-current="page">
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
      <div className="insights">
        <button type="button" className="rail-button" aria-label={TEXT.insights} aria-describedby={tipId} aria-disabled="true">
          <InsightsIcon />
        </button>
        <div role="tooltip" id={tipId} className="insights-tip">
          <p className="insights-title">{TEXT.insights}</p>
          <ul>
            {AI_CLIS.map((cli) => (
              <li key={cli.id}>
                <span>{cli.name}</span>
                <span className="insights-state">{TEXT.usageLater}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <button type="button" className="rail-button" aria-label={TEXT.settings} title={TEXT.settings} aria-disabled="true">
        <SettingsIcon />
      </button>
      <button
        type="button"
        className="rail-button"
        data-tone={attention > 0 ? "fail" : undefined}
        aria-label={withCount(TEXT.attention, attention)}
        title={withCount(TEXT.attention, attention)}
        aria-disabled="true"
      >
        <AttentionIcon />
        <Badge count={attention} tone="fail" />
      </button>
      <div className="rail-spacer" />
      <span className="rail-user" role="img" aria-label={TEXT.user} title={TEXT.user}>
        <UserIcon />
      </span>
    </nav>
  );
}

function Badge({ count, tone }: { readonly count: number; readonly tone: "warn" | "fail" }) {
  if (count <= 0) return null;
  return (
    <span className="badge" data-tone={tone} aria-hidden="true">
      {count > 99 ? "99+" : count}
    </span>
  );
}
