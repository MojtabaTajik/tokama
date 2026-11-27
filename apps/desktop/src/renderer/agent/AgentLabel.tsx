// The agent of a step as a small label (dot, name, model) with a tooltip that says who owns it, what it
// runs on and what it may do. The tooltip opens on hover after a short rest and at once on keyboard focus,
// stays open while the pointer or the focus is on the label or the tooltip, and Escape closes it. The label
// does nothing when clicked. It sits next to the row's own button, never inside it. Engine text (names,
// models, commands, the role) is rendered as React text only.
import type { CSSProperties } from "react";
import { useEffect, useId, useRef } from "react";
import type { AgentTarget } from "../settings/describe.js";
import { cliName } from "../model.js";
import { useTip } from "../ui/useTip.js";
import { type AgentAccess, type AgentInfo, extraPower } from "./agent-info.js";
import { Button } from "../ui/Button.js";
import { AgentDotMark, BackendMark } from "../ui/agent.js";
import { Pill } from "../ui/Pill.js";
import { Tooltip } from "../ui/Tooltip.js";
import { BuiltinIcon, EyeIcon, GlobeIcon, PencilIcon, RepoIcon, ShellIcon, UserIcon } from "../ui/icons.js";

const TEXT = {
  builtin: "built-in",
  personal: "personal",
  repo: "repo",
  may: "May",
  edits: "edits files",
  readsOnly: "reads files only",
  runs: "runs:",
  runsNothing: "runs: nothing",
  webOn: "web: on",
  webOff: "web: off",
  open: "Open in Settings →",
  more: (count: number) => `+${count} more`,
} as const;

/** The commands the tooltip names before it says how many more there are. */
const SHOWN_COMMANDS = 4;

export interface AgentLabelProps {
  readonly info: AgentInfo;
  /** Opens the agent in Settings → Agents; without it the tooltip has no link. */
  readonly onOpen?: ((agent: AgentTarget) => void) | undefined;
}

export function AgentLabel({ info, onOpen }: AgentLabelProps) {
  const tip = useTip(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  // A dashed ident for the anchor, one per label: useId's colons are not valid in one.
  const anchor = `--agent-${tipId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const { open, dismiss } = tip;

  // Escape closes the tooltip before anything else handles it, so an open drawer stays open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Focus on the tooltip's link would fall to the page when the tooltip goes: it goes back to the label.
      if (wrapper.current?.contains(document.activeElement) === true) button.current?.focus();
      dismiss();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [open, dismiss]);

  return (
    <span ref={wrapper} className="al" {...tip.triggers}>
      <Button variant="plain" ref={button} className="al-button" data-open={open || undefined} aria-describedby={open ? tipId : undefined} style={{ anchorName: anchor } as CSSProperties}>
        <span className="al-who">
          <AgentDotMark dot={info.dot} />
          {info.cliId !== undefined && <BackendMark cliId={info.cliId} named hoverName={false} />}
          <span className="ellipsis">{info.name}</span>
        </span>{" "}
        {info.model !== undefined && <span className="al-model">· {info.model}</span>}
      </Button>
      {open && <Tip id={tipId} anchor={anchor} info={info} onOpen={onOpen} />}
    </span>
  );
}

function Tip({ id, anchor, info, onOpen }: { readonly id: string; readonly anchor: string; readonly info: AgentInfo; readonly onOpen: AgentLabelProps["onOpen"] }) {
  const { access } = info;
  return (
    <Tooltip id={id} anchor={anchor} className="al-tip">
      <div className="al-head">
        <AgentDotMark dot={info.dot} />
        <b className="al-name">{info.name}</b>
        {access !== undefined && <Owner access={access} />}
      </div>
      {info.cliId !== undefined && (
        <div className="al-run">
          <span className="al-cli">
            <BackendMark cliId={info.cliId} size={16} /> {cliName(info.cliId)}
          </span>
          {info.model !== undefined && <span className="mono">{info.model}</span>}
        </div>
      )}
      {access !== undefined && <May access={access} />}
      {access?.role !== undefined && <p className="al-role">{`“${access.role}”`}</p>}
      {onOpen !== undefined && (
        <div className="al-foot">
          <Button variant="plain" className="al-open" onClick={() => onOpen({ id: info.id, owner: access?.owner, repoId: access?.repoId })}>
            {TEXT.open}
          </Button>
        </div>
      )}
    </Tooltip>
  );
}

function Owner({ access }: { readonly access: AgentAccess }) {
  return (
    <Pill round className="al-owner">
      {access.owner === "builtin" ? <ShieldGlyph /> : access.owner === "personal" ? <PersonGlyph /> : <RepoGlyph />}
      {TEXT[access.owner]}
      {access.repoId !== undefined && <span className="mono"> {access.repoId}</span>}
    </Pill>
  );
}

/** What the agent may do, each part with its icon and its words; a repo agent's extra power is amber. */
function May({ access }: { readonly access: AgentAccess }) {
  const extra = extraPower(access);
  const shown = access.commands.slice(0, SHOWN_COMMANDS);
  return (
    <div className="al-may">
      <span className="al-may-label">{TEXT.may}</span>
      <span className="al-can">
        {access.edit ? <PencilGlyph /> : <EyeGlyph />}
        {access.edit ? TEXT.edits : TEXT.readsOnly}
      </span>
      <Dot />
      <span className="al-can" data-extra={extra.commands || undefined}>
        <TerminalGlyph />
        {access.commands.length === 0 ? (
          TEXT.runsNothing
        ) : (
          <span>
            {TEXT.runs}{" "}
            {shown.map((command, index) => (
              <span key={index}>
                {index > 0 && ", "}
                <span className="mono al-command">{command}</span>
              </span>
            ))}
            {access.commands.length > shown.length && <span>{`, ${TEXT.more(access.commands.length - shown.length)}`}</span>}
          </span>
        )}
      </span>
      <Dot />
      <span className="al-can" data-extra={extra.web || undefined}>
        <GlobeGlyph off={!access.web} />
        {access.web ? TEXT.webOn : TEXT.webOff}
      </span>
    </div>
  );
}

const Dot = () => (
  <span className="al-sep" aria-hidden="true">
    ·
  </span>
);

const ShieldGlyph = () => <BuiltinIcon size={11} />;
const PersonGlyph = () => <UserIcon size={11} />;
const RepoGlyph = () => <RepoIcon size={11} />;
const PencilGlyph = () => <PencilIcon />;
const EyeGlyph = () => <EyeIcon />;
const TerminalGlyph = () => <ShellIcon />;
const GlobeGlyph = ({ off }: { readonly off: boolean }) => <GlobeIcon off={off} />;
