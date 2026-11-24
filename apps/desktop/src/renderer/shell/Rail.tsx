// The icon rail (CLAUDE.md, locked layout): panel toggle, Board, Needs you, Insights, Settings,
// Attention, one usage ring per AI CLI, then the user. Only the panel toggle acts for now;
// the other destinations come with their screens.
import { brand } from "../brand/index.js";
import { AI_CLIS } from "../model.js";
import { AttentionIcon, BoardIcon, InboxIcon, InsightsIcon, PanelIcon, SettingsIcon, UserIcon } from "./icons.js";

const TEXT = {
  rail: "App",
  showPanel: "Show workspaces",
  hidePanel: "Hide workspaces",
  board: "Board",
  needsYou: "Needs you",
  insights: "Insights",
  settings: "Settings",
  attention: "Attention",
  usageUnknown: "usage not measured yet",
  user: "You",
} as const;

export interface RailProps {
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
  readonly needsYou: number;
  /** Health issues (expiring token, quota, a host's model server down). None are reported yet. */
  readonly attention: number;
}

/** "Needs you · 2", or just "Needs you" when there are none. */
const withCount = (label: string, count: number) => (count > 0 ? `${label} · ${count}` : label);

export function Rail({ panelOpen, onTogglePanel, needsYou, attention }: RailProps) {
  const panelLabel = panelOpen ? TEXT.hidePanel : TEXT.showPanel;
  return (
    <nav className="rail" aria-label={TEXT.rail}>
      <img className="rail-mark" src={brand.markUrl} alt={brand.name} width={22} height={22} />
      <button type="button" className="rail-button" aria-label={panelLabel} title={panelLabel} aria-pressed={panelOpen} onClick={onTogglePanel}>
        <PanelIcon />
      </button>
      <button type="button" className="rail-button" aria-label={TEXT.board} title={TEXT.board} aria-current="page">
        <BoardIcon />
      </button>
      <button type="button" className="rail-button" data-tone={needsYou > 0 ? "warn" : undefined} aria-label={withCount(TEXT.needsYou, needsYou)} title={withCount(TEXT.needsYou, needsYou)}>
        <InboxIcon />
        <Badge count={needsYou} tone="warn" />
      </button>
      <button type="button" className="rail-button" aria-label={TEXT.insights} title={TEXT.insights}>
        <InsightsIcon />
      </button>
      <button type="button" className="rail-button" aria-label={TEXT.settings} title={TEXT.settings}>
        <SettingsIcon />
      </button>
      <button type="button" className="rail-button" data-tone={attention > 0 ? "fail" : undefined} aria-label={withCount(TEXT.attention, attention)} title={withCount(TEXT.attention, attention)}>
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
    <button type="button" className="usage-ring" aria-label={label} title={label}>
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="16" />
      </svg>
      <span className="mono">{monogram}</span>
    </button>
  );
}
