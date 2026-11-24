// The icon rail: panel toggle, Board, Needs you, Insights, Settings,
// Attention, one usage ring per AI CLI, then the user. Only the panel toggle acts for now; the
// other buttons are marked aria-disabled until their screens exist.
import { brand } from "../brand/index.js";
import { AI_CLIS } from "../model.js";
import { AttentionIcon, BoardIcon, InboxIcon, InsightsIcon, PanelIcon, SettingsIcon, UserIcon } from "./icons.js";

const TEXT = {
  rail: "App",
  panel: "Workspaces panel",
  board: "Board",
  needsYou: "Needs you",
  outOfDate: "out of date",
  insights: "Insights",
  settings: "Settings",
  attention: "Attention",
  usageUnknown: "usage not measured yet",
  user: "You",
} as const;

export interface RailProps {
  readonly panelOpen: boolean;
  /** The id of the workspaces panel, which the toggle controls while it is shown. */
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
      <button type="button" className="rail-button" aria-label={TEXT.insights} title={TEXT.insights} aria-disabled="true">
        <InsightsIcon />
      </button>
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
      {AI_CLIS.map((cli) => (
        <UsageRing key={cli.id} monogram={cli.monogram} label={`${cli.name} · ${TEXT.usageUnknown}`} />
      ))}
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

/** A usage ring with its text monogram. Only the track for now: usage sources come later. */
function UsageRing({ monogram, label }: { readonly monogram: string; readonly label: string }) {
  return (
    <button type="button" className="usage-ring" aria-label={label} title={label} aria-disabled="true">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="16" />
      </svg>
      <span className="mono">{monogram}</span>
    </button>
  );
}
