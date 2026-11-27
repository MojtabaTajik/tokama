// A template's or agent's icon: a Lucide line icon in the current colour, tinted with the template's tag
// colour. Only the icons listed in ICONS are bundled; a name that is not listed (or a missing one) draws
// the neutral default. A colour that is not one of the 8 tag colours draws no tint, so the icon keeps the
// colour of its surroundings. Decorative: the template's name always sits next to it.
import {
  Bell,
  Book,
  Brain,
  Bug,
  ChartLine,
  Clipboard,
  ClipboardCheck,
  Clock,
  Cloud,
  Code,
  Cog,
  CircleCheck,
  CircleQuestionMark,
  Compass,
  Crosshair,
  Database,
  Eye,
  FileText,
  Flag,
  Flame,
  FlaskConical,
  Gauge,
  GitBranch,
  Hammer,
  KeyRound,
  Layers,
  Lightbulb,
  ListChecks,
  Lock,
  type LucideIcon,
  Microscope,
  Network,
  Package,
  Puzzle,
  RadioTower,
  Rocket,
  Route,
  Search,
  Send,
  Server,
  ShieldHalf,
  Stethoscope,
  Terminal,
  TextSearch,
  ToolCase,
  TriangleExclamationPoint,
  WandSparkles,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type { TemplateSummary } from "@tokama/core";

/** The tag colours the engine sends; the theme defines a `--tag-*` token for each, and app.css tints the icon with it. */
type EngineColor = NonNullable<TemplateSummary["color"]>;
export const TAG_COLORS = ["slate", "sky", "teal", "moss", "sand", "clay", "rose", "plum"] as const satisfies readonly EngineColor[];
// Fails to compile when the engine gains a colour that this list lacks.
const _everyColorListed: Exclude<EngineColor, (typeof TAG_COLORS)[number]> extends never ? true : never = true;
void _everyColorListed;
export type TagColor = (typeof TAG_COLORS)[number];

/** The name and the icon an icon name that is missing or not listed draws. */
export const DEFAULT_NAME = "diagram-project";
export const DEFAULT_ICON: LucideIcon = Workflow;

/** The bundled icons by name. The names are the ones template and agent files use. */
export const ICONS: ReadonlyMap<string, LucideIcon> = new Map<string, LucideIcon>([
  ["bell", Bell],
  ["bolt", Zap],
  ["book", Book],
  ["box", Package],
  ["brain", Brain],
  ["bug", Bug],
  ["chart-line", ChartLine],
  ["circle-check", CircleCheck],
  ["circle-question", CircleQuestionMark],
  ["clipboard", Clipboard],
  ["clipboard-check", ClipboardCheck],
  ["clock", Clock],
  ["cloud", Cloud],
  ["code", Code],
  ["code-branch", GitBranch],
  ["compass", Compass],
  ["crosshairs", Crosshair],
  ["database", Database],
  [DEFAULT_NAME, DEFAULT_ICON],
  ["eye", Eye],
  ["file-lines", FileText],
  ["fire", Flame],
  ["flag", Flag],
  ["flask", FlaskConical],
  ["gauge", Gauge],
  ["gear", Cog],
  ["hammer", Hammer],
  ["key", KeyRound],
  ["layer-group", Layers],
  ["lightbulb", Lightbulb],
  ["list-check", ListChecks],
  ["lock", Lock],
  ["magnifying-glass", Search],
  ["magnifying-glass-chart", TextSearch],
  ["microscope", Microscope],
  ["paper-plane", Send],
  ["puzzle-piece", Puzzle],
  ["rocket", Rocket],
  ["route", Route],
  ["screwdriver-wrench", ToolCase],
  ["server", Server],
  ["shield-halved", ShieldHalf],
  ["sitemap", Network],
  ["stethoscope", Stethoscope],
  ["terminal", Terminal],
  ["tower-broadcast", RadioTower],
  ["triangle-exclamation", TriangleExclamationPoint],
  ["wand-magic-sparkles", WandSparkles],
  ["wrench", Wrench],
]);

/** Older names that template files already use (Font Awesome called them aliases), each pointing at the name above that draws it. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["project-diagram", "diagram-project"],
  ["zap", "bolt"],
  ["line-chart", "chart-line"],
  ["file-alt", "file-lines"],
  ["file-text", "file-lines"],
  ["dashboard", "gauge"],
  ["gauge-med", "gauge"],
  ["tachometer-alt-average", "gauge"],
  ["cog", "gear"],
  ["tasks", "list-check"],
  ["search", "magnifying-glass"],
  ["tools", "screwdriver-wrench"],
  ["shield-alt", "shield-halved"],
  ["exclamation-triangle", "triangle-exclamation"],
  ["warning", "triangle-exclamation"],
  ["magic-wand-sparkles", "wand-magic-sparkles"],
]);

/** The icon to draw for a name, with the name it is listed under; the neutral default for a name that is missing or not listed. */
export function iconOf(name: string | undefined): { readonly name: string; readonly Icon: LucideIcon } {
  const listed = name === undefined ? undefined : (ALIASES.get(name) ?? name);
  const Icon = listed === undefined ? undefined : ICONS.get(listed);
  return listed !== undefined && Icon !== undefined ? { name: listed, Icon } : { name: DEFAULT_NAME, Icon: DEFAULT_ICON };
}

export const tagOf = (color: string | undefined): TagColor | undefined => TAG_COLORS.find((tag) => tag === color);

export interface TemplateIconProps {
  readonly icon?: string | undefined;
  readonly color?: string | undefined;
  readonly size?: number;
}

export function TemplateIcon({ icon, color, size = 12 }: TemplateIconProps) {
  const { name, Icon } = iconOf(icon);
  return <Icon className="tpl-icon" data-icon={name} data-tag={tagOf(color)} size={size} aria-hidden="true" focusable="false" />;
}
