// A template's icon: a Font Awesome Free solid icon drawn as inline SVG in the current colour,
// tinted with the template's tag colour. Only the icons listed in ICONS are bundled; a name that is
// not listed (or a missing one) draws the neutral default. A colour that is not one of the 8 tag
// colours draws no tint, so the icon keeps the colour of its surroundings. Decorative: the
// template's name always sits next to it.
import {
  faBell,
  faBolt,
  faBook,
  faBox,
  faBrain,
  faBug,
  faChartLine,
  faClipboardCheck,
  faCloud,
  faCode,
  faCodeBranch,
  faCrosshairs,
  faDatabase,
  faDiagramProject,
  faEye,
  faFileLines,
  faFire,
  faFlag,
  faFlask,
  faGauge,
  faGear,
  faHammer,
  faKey,
  faLightbulb,
  faListCheck,
  faLock,
  faMagnifyingGlass,
  faMicroscope,
  faPaperPlane,
  faPuzzlePiece,
  faRocket,
  faRoute,
  faScrewdriverWrench,
  faServer,
  faShieldHalved,
  faSitemap,
  faStethoscope,
  faTerminal,
  faTriangleExclamation,
  faWandMagicSparkles,
  faWrench,
  type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import type { TemplateSummary } from "@tokama/core";

/** The tag colours the engine sends; the theme defines a `--tag-*` token for each, and app.css tints the icon with it. */
type EngineColor = NonNullable<TemplateSummary["color"]>;
export const TAG_COLORS = ["slate", "sky", "teal", "moss", "sand", "clay", "rose", "plum"] as const satisfies readonly EngineColor[];
// Fails to compile when the engine gains a colour that this list lacks.
const _everyColorListed: Exclude<EngineColor, (typeof TAG_COLORS)[number]> extends never ? true : never = true;
void _everyColorListed;
export type TagColor = (typeof TAG_COLORS)[number];

/** What an icon name that is missing or not listed draws. */
export const DEFAULT_ICON = faDiagramProject;

const LISTED: readonly IconDefinition[] = [
  DEFAULT_ICON,
  faBell,
  faBolt,
  faBook,
  faBox,
  faBrain,
  faBug,
  faChartLine,
  faClipboardCheck,
  faCloud,
  faCode,
  faCodeBranch,
  faCrosshairs,
  faDatabase,
  faEye,
  faFileLines,
  faFire,
  faFlag,
  faFlask,
  faGauge,
  faGear,
  faHammer,
  faKey,
  faLightbulb,
  faListCheck,
  faLock,
  faMagnifyingGlass,
  faMicroscope,
  faPaperPlane,
  faPuzzlePiece,
  faRocket,
  faRoute,
  faScrewdriverWrench,
  faServer,
  faShieldHalved,
  faSitemap,
  faStethoscope,
  faTerminal,
  faTriangleExclamation,
  faWandMagicSparkles,
  faWrench,
];

/** The bundled icons by name, each also under the older names Font Awesome keeps as aliases. */
export const ICONS: ReadonlyMap<string, IconDefinition> = new Map(
  LISTED.flatMap((definition) => [definition.iconName, ...definition.icon[2].filter((alias): alias is string => typeof alias === "string")].map((name) => [name, definition] as const)),
);

export const iconOf = (name: string | undefined): IconDefinition => (name === undefined ? undefined : ICONS.get(name)) ?? DEFAULT_ICON;

export const tagOf = (color: string | undefined): TagColor | undefined => TAG_COLORS.find((tag) => tag === color);

export interface TemplateIconProps {
  readonly icon?: string | undefined;
  readonly color?: string | undefined;
  readonly size?: number;
}

export function TemplateIcon({ icon, color, size = 12 }: TemplateIconProps) {
  const definition = iconOf(icon);
  const [width, height, , , path] = definition.icon;
  return (
    <svg className="tpl-icon" data-icon={definition.iconName} data-tag={tagOf(color)} width={size} height={size} viewBox={`0 0 ${width} ${height}`} fill="currentColor" aria-hidden="true">
      <path d={Array.isArray(path) ? path.join(" ") : path} />
    </svg>
  );
}
