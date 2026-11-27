// The app's icons, all from Lucide (stroke 2, no fill, the current colour): the rail's (18 px), the settings nav's (16 px), the chips' (13 px) and the small ones of
// sidebar rows and headers (12 px). Decorative: every button that shows one has its own label. This file and shell/TemplateIcon.tsx are the only places that import
// Lucide, so every icon of the app comes from one set at one stroke weight.
import {
  Activity,
  Bell,
  Bot,
  ChartColumn,
  ChartLine,
  Check,
  ChevronRight,
  CircleArrowDown,
  CircleX,
  Copy,
  Eye,
  GitBranch,
  Globe,
  GlobeOff,
  Inbox,
  Kanban,
  List,
  type LucideIcon,
  Maximize2,
  Minimize2,
  Package,
  PanelLeft,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  ShieldExclamationPoint,
  SquareTerminal,
  Terminal,
  TriangleExclamationPoint,
  User,
  Workflow,
} from "lucide-react";

export interface IconProps {
  readonly size?: number;
}

/** An icon component of a default size; the stroke is Lucide's own, so no icon can differ in weight. */
const lucide =
  (Icon: LucideIcon, size: number) =>
  ({ size: shown = size }: IconProps) => <Icon size={shown} aria-hidden="true" focusable="false" />;

export const PanelIcon = lucide(PanelLeft, 18);
export const BoardIcon = lucide(Kanban, 18);
export const InboxIcon = lucide(Inbox, 18);
export const InsightsIcon = lucide(ChartLine, 18);
export const SettingsIcon = lucide(Settings, 18);
export const AttentionIcon = lucide(TriangleExclamationPoint, 18);
export const UserIcon = lucide(User, 18);
export const RepoIcon = lucide(GitBranch, 12);
export const AllWorkIcon = lucide(List, 12);
/** ⤢: open in the full view. */
export const ExpandIcon = lucide(Maximize2, 15);
/** ⤡: close the full view. */
export const CollapseIcon = lucide(Minimize2, 16);
export const BellIcon = lucide(Bell, 16);
export const PulseIcon = lucide(Activity, 16);
/** The Repos page of Settings: the same branch as every other repo. */
export const BookIcon = lucide(GitBranch, 16);
export const TemplateListIcon = lucide(Workflow, 16);
export const AgentIcon = lucide(Bot, 16);
export const TerminalIcon = lucide(SquareTerminal, 16);
/** A triangle with an exclamation mark: important. */
export const WarningIcon = lucide(TriangleExclamationPoint, 18);
export const SearchIcon = lucide(Search, 13);
/** › : points right; a section's arrow, turned down by CSS while it is open. */
export const ChevronIcon = lucide(ChevronRight, 14);

// The three icons below are the ones a sidebar chip (ui/Chip.tsx) shows; chip icons are 13 px.
export const CheckIcon = lucide(Check, 13);
/** A shield with a tick: a fix for a security problem. */
export const ShieldIcon = lucide(ShieldCheck, 13);
/** Two sheets: copy to the clipboard. */
export const CopyIcon = lucide(Copy, 13);

/** A shield with an exclamation mark: a note on what runs with the user's access. */
export const ShieldNoteIcon = lucide(ShieldExclamationPoint, 15);
/** A circle with an arrow down: an update to download. */
export const DownloadIcon = lucide(CircleArrowDown, 13);

// What an agent's tooltip and the Diagnostics rows draw, 12 and 13 px.
/** A box: the owner of a built-in agent. */
export const BuiltinIcon = lucide(Package, 12);
export const PencilIcon = lucide(Pencil, 12);
export const EyeIcon = lucide(Eye, 12);
/** A prompt: the commands an agent runs. */
export const ShellIcon = lucide(Terminal, 12);
export const ErrorIcon = lucide(CircleX, 13);
export const UsageIcon = lucide(ChartColumn, 13);

export const GlobeIcon = ({ off, size = 12 }: IconProps & { readonly off: boolean }) => {
  const Icon = off ? GlobeOff : Globe;
  return <Icon size={size} aria-hidden="true" focusable="false" />;
};
