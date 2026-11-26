// The Get started checklist: four rows, each with a mark, a word, the fix for what is wrong and
// one action. Only the first step that is not done has the filled button. The rows come from
// checklist.ts; this file only draws them. What the engine wrote is shown as text, never as markup.
import { BackendMark } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { CommandCopy } from "../ui/CommandCopy.js";
import { ExternalLink } from "../ui/ExternalLink.js";
import { ShieldNoteIcon } from "../ui/icons.js";
import { StatusMark } from "../ui/status.js";
import type { Action, Checklist, Part, Row } from "./checklist.js";
import { TEXT } from "./words.js";

export type PartAction = Extract<Part, { act: unknown }>["act"]["id"];
export type Prefill = NonNullable<Extract<Action, { kind: "start" }>["prefill"]>;

export interface GetStartedProps {
  readonly list: Checklist;
  /** A check is running: Check again waits for it. */
  readonly checking: boolean;
  readonly onCheckAgain: () => void;
  readonly onAddRepo: () => void;
  /** Start a Quick fix: opens New work with this filled in. */
  readonly onStart: (prefill: Prefill) => void;
  readonly onAct: (id: PartAction) => void;
  /** Opened from Help: a Close link hides the list again. */
  readonly onClose?: (() => void) | undefined;
}

export function GetStarted({ list, checking, onCheckAgain, onAddRepo, onStart, onAct, onClose }: GetStartedProps) {
  return (
    <section className="gs" aria-label={TEXT.heading}>
      <div className="gs-head">
        <h2 className="gs-title">{TEXT.heading}</h2>
        <span className="gs-count mono">{TEXT.progress(list.doneCount)}</span>
        <span className="gs-head-links">
          <Button variant="link" disabled={checking} onClick={onCheckAgain}>
            {TEXT.checkAgain}
          </Button>
          {onClose !== undefined && (
            <Button variant="link" onClick={onClose}>
              {TEXT.close}
            </Button>
          )}
        </span>
      </div>
      <p className="gs-intro">{list.subtitle}</p>
      <ol className="gs-rows" aria-label={TEXT.list}>
        {list.rows.map((row) => (
          <RowView key={row.id} row={row} filled={row.id === list.next} onCheckAgain={onCheckAgain} onAddRepo={onAddRepo} onStart={onStart} onAct={onAct} />
        ))}
      </ol>
      <p className="gs-note">
        <span className="gs-note-icon" aria-hidden="true">
          <ShieldNoteIcon />
        </span>
        <span>
          <b>{TEXT.safetyTitle}</b> {TEXT.safety}{" "}
          <Button variant="link" inline onClick={() => onAct("open-templates")}>
            {TEXT.safetyLink}
          </Button>
          .
        </span>
      </p>
    </section>
  );
}

interface RowViewProps {
  readonly row: Row;
  /** This is the next step: its action is the filled button. */
  readonly filled: boolean;
  readonly onCheckAgain: () => void;
  readonly onAddRepo: () => void;
  readonly onStart: (prefill: Prefill) => void;
  readonly onAct: (id: PartAction) => void;
}

function RowView({ row, filled, onCheckAgain, onAddRepo, onStart, onAct }: RowViewProps) {
  return (
    <li className="gs-row" data-row={row.id}>
      <span className="gs-mark">
        <StatusMark status={row.mark} />
      </span>
      <div className="gs-body">
        <span className="gs-line">
          <b className="gs-row-title">{row.title}</b>
          <span className="gs-word" data-tone={row.mark.tone}>
            {row.word}
          </span>
        </span>
        <span className="gs-detail">
          {row.detail.map((part, index) => (
            <PartView key={index} part={part} onAct={onAct} />
          ))}
          {row.engineText !== undefined && <span className="gs-engine-text">{row.engineText}</span>}
          {row.command !== undefined && (
            <span className="gs-command">
              <CommandCopy command={row.command} />
            </span>
          )}
        </span>
      </div>
      {row.action !== undefined && <ActionView action={row.action} filled={filled} onCheckAgain={onCheckAgain} onAddRepo={onAddRepo} onStart={onStart} />}
    </li>
  );
}

function PartView({ part, onAct }: { readonly part: Part; readonly onAct: (id: PartAction) => void }) {
  if (typeof part === "string") return <>{part}</>;
  if ("strong" in part) return <b className="gs-strong">{part.strong}</b>;
  if ("code" in part) return <code className="mono gs-code">{part.code}</code>;
  if ("quote" in part) return <q className="gs-quote">{part.quote}</q>;
  if ("tool" in part) return <BackendMark cliId={part.tool} />;
  if ("link" in part) return <ExternalLink href={part.link.href}>{part.link.text}</ExternalLink>;
  return (
    <Button variant="link" inline onClick={() => onAct(part.act.id)}>
      {part.act.text}
    </Button>
  );
}

interface ActionViewProps {
  readonly action: Action;
  readonly filled: boolean;
  readonly onCheckAgain: () => void;
  readonly onAddRepo: () => void;
  readonly onStart: (prefill: Prefill) => void;
}

function ActionView({ action, filled, onCheckAgain, onAddRepo, onStart }: ActionViewProps) {
  const variant = filled ? "primary" : "secondary";
  switch (action.kind) {
    case "link":
      return (
        <ExternalLink href={action.href} variant={variant} className="gs-action">
          {action.label}
        </ExternalLink>
      );
    case "add-repo":
      return (
        <Button variant={variant} className="gs-action" onClick={onAddRepo}>
          {action.label}
        </Button>
      );
    case "check-again":
      return (
        <Button variant="secondary" className="gs-action" onClick={onCheckAgain}>
          {action.label}
        </Button>
      );
    case "start":
      return (
        <Button variant={variant} className="gs-action" disabled={action.locked} onClick={() => action.prefill !== undefined && onStart(action.prefill)}>
          {action.label}
        </Button>
      );
  }
}
