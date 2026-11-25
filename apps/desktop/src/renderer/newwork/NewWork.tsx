// The New work input, floating at the bottom of the main area. A single line until it is focused;
// then it expands upward with the Template and Repos dropdowns, what the template uses, its steps
// on one line, the commands it runs on this machine, its warnings and Start (Cmd or Ctrl and Enter). Start sends `start_item` and
// hands the new item's id up. Engine text (names, error messages) renders as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import { type FormEvent, type KeyboardEvent, type Ref, useId, useImperativeHandle, useRef, useState } from "react";
import { BRIDGE_ERROR_CODES, type TokamaBridge } from "../../shared/bridge.js";
import { agentLines, commandsOf, KIND_GROUPS, missing, needsRepo, noChecks, reposFor, stepsLine, usesOf } from "./needs.js";
import { Picker } from "./Picker.js";
import { useSuggestion } from "./useSuggestion.js";

const TEXT = {
  form: "New work",
  describe: "Describe a task or paste an alert",
  placeholder: "Describe a task or paste an alert…",
  collapse: "Collapse",
  template: "Template",
  chooseTemplate: "Choose…",
  searchTemplates: "Search templates",
  suggested: "suggested",
  repos: "Repos",
  searchRepos: "Search repos",
  optional: "none (optional)",
  chooseRepos: "Choose…",
  repoCount: (count: number) => `${count} repos`,
  uses: "uses",
  steps: "Steps",
  runs: "Runs on your machine",
  warning: "Warning",
  start: "Start",
  starting: "Starting…",
  notConnected: "Not connected to the engine. Try again when it is back.",
  failed: (message: string) => `Could not start the work: ${message}`,
  instead: (name: string) => `${name} lets you review the diff yourself instead.`,
  use: (name: string) => `Use ${name}`,
} as const;

/** macOS uses Cmd for shortcuts, other systems Ctrl. */
export const isMac = (): boolean => typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
/** The longest text `start_item` accepts. */
const MAX_TEXT = 4000;

export interface NewWorkHandle {
  /** Expands the input, focuses it, and fills the template or the repo when given. */
  open(prefill?: { readonly templateId?: string; readonly repoId?: string }): void;
}

export interface NewWorkProps {
  readonly bridge: TokamaBridge;
  readonly setup: Setup;
  readonly ref?: Ref<NewWorkHandle>;
  /** The repo whose list is open: chosen until the user picks repos themselves. */
  readonly repoId?: string | undefined;
  /** The engine accepted the work: what the new item is and where it belongs. */
  readonly onStarted: (itemId: string, started: Pick<ItemRecord, "templateId" | "repoIds">) => void;
}

export function NewWork({ bridge, setup, ref, repoId, onStarted }: NewWorkProps) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // Undefined until the user picks repos: then the open repo list's repo, if any, is the choice.
  const [picks, setPicks] = useState<readonly string[] | undefined>(undefined);
  const repoIds = picks ?? (repoId === undefined ? [] : [repoId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  // What had focus before the input took it: Escape gives it back.
  const origin = useRef<HTMLElement | undefined>(undefined);
  const reasonId = useId();

  const suggestion = useSuggestion(bridge, text);
  const suggestedId = suggestion?.templateId;
  // The user's own choice wins; until then the engine's suggestion applies. An out-of-date
  // suggestion is still shown, so the name does not flicker, but Start waits for the current one.
  const shown = setup.templates.find((candidate) => candidate.id === (picked ?? suggestedId));
  const template = picked !== undefined || suggestion?.fresh === true ? shown : undefined;
  // In the setup's order; a repo that left the setup, or that the template cannot run on, drops out.
  const repos = reposFor(shown, setup.repos);
  const chosenRepos = repos.filter((repo) => repoIds.includes(repo.id)).map((repo) => repo.id);
  const blocked = noChecks(shown, setup.repos, chosenRepos, setup.templates);
  const reason = missing({ template, text, repoIds: chosenRepos }) ?? blocked?.reason;

  useImperativeHandle(ref, () => ({
    open(prefill) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== input.current) origin.current = active;
      if (prefill?.templateId !== undefined) setPicked(prefill.templateId);
      if (prefill?.repoId !== undefined) setPicks([prefill.repoId]);
      setExpanded(true);
      input.current?.focus();
    },
  }));

  const collapse = () => {
    setExpanded(false);
    const target = origin.current;
    origin.current = undefined;
    if (target?.isConnected) target.focus();
    else input.current?.blur();
  };

  const start = async () => {
    if (template === undefined || reason !== undefined || busy) return;
    setBusy(true);
    setError(undefined);
    // No options: the engine decides their defaults.
    const command = { type: "start_item", templateId: template.id, repoIds: chosenRepos, text: text.trim() } as const;
    const reply = await bridge.command(command).catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    setBusy(false);
    if (!reply.ok) {
      setError(reply.error.code === BRIDGE_ERROR_CODES.notConnected ? TEXT.notConnected : TEXT.failed(reply.error.message));
      return;
    }
    setText("");
    setPicked(undefined);
    setPicks(undefined);
    collapse();
    onStarted(reply.data.itemId, { templateId: template.id, repoIds: command.repoIds });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // A dropdown that handled Escape has already prevented it.
    if (event.key === "Escape" && !event.defaultPrevented && expanded) {
      event.preventDefault();
      collapse();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void start();
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void start();
  };

  const toggleRepo = (id: string) => setPicks(repoIds.includes(id) ? repoIds.filter((chosen) => chosen !== id) : [...repoIds, id]);
  const uses = shown ? usesOf(shown, setup.connections) : [];
  const commands = shown ? commandsOf(shown, setup.repos, chosenRepos) : [];
  const agents = shown ? agentLines(shown) : [];

  return (
    <div className="np">
      <form className="np-form" aria-label={TEXT.form} data-expanded={expanded || undefined} onKeyDown={onKeyDown} onSubmit={onSubmit}>
        <div className="np-top">
          <label htmlFor={`${reasonId}-text`} className="visually-hidden">
            {TEXT.describe}
          </label>
          <textarea
            id={`${reasonId}-text`}
            ref={input}
            className="np-text"
            rows={expanded ? 3 : 1}
            maxLength={MAX_TEXT}
            placeholder={TEXT.placeholder}
            value={text}
            onFocus={(event) => {
              if (!expanded && event.relatedTarget instanceof HTMLElement) origin.current = event.relatedTarget;
              setExpanded(true);
            }}
            onChange={(event) => setText(event.target.value)}
          />
          {expanded && (
            <button type="button" className="np-collapse" aria-label={TEXT.collapse} onClick={collapse}>
              ⌄
            </button>
          )}
        </div>
        {expanded && (
          <div className="np-body">
            <div className="np-row">
              <Picker
                label={TEXT.template}
                summary={shown ? `${shown.name}${picked === undefined ? ` (${TEXT.suggested})` : ""}` : TEXT.chooseTemplate}
                searchLabel={TEXT.searchTemplates}
                multi={false}
                selected={new Set(shown ? [shown.id] : [])}
                groups={KIND_GROUPS.map(({ kind, heading }) => ({
                  heading,
                  options: setup.templates.filter((candidate) => candidate.kind === kind).map((candidate) => ({ id: candidate.id, label: candidate.name, tag: candidate.id === suggestedId ? TEXT.suggested : undefined })),
                }))}
                onPick={setPicked}
              />
              <Picker
                label={TEXT.repos}
                summary={chosenRepos.length === 0 ? (shown === undefined || needsRepo(shown) ? TEXT.chooseRepos : TEXT.optional) : chosenRepos.length === 1 ? (chosenRepos[0] ?? "") : TEXT.repoCount(chosenRepos.length)}
                searchLabel={TEXT.searchRepos}
                multi
                selected={new Set(chosenRepos)}
                groups={[{ options: repos.map((repo) => ({ id: repo.id, label: repo.id })) }]}
                onPick={toggleRepo}
              />
              {uses.length > 0 && (
                <span className="np-uses">
                  <span className="np-muted">{TEXT.uses}</span>
                  {uses.map((use) => (
                    <span key={use} className="np-badge">
                      {use}
                    </span>
                  ))}
                </span>
              )}
            </div>
            {shown && (
              <p className="np-steps mono ellipsis" title={stepsLine(shown, setup.agents)}>
                <span className="visually-hidden">{TEXT.steps}: </span>
                {stepsLine(shown, setup.agents)}
              </p>
            )}
            {commands.length > 0 && (
              <p className="np-commands">
                <span className="np-muted">{TEXT.runs}</span>
                {commands.map((command) => (
                  <code key={command} className="np-badge mono">
                    {command}
                  </code>
                ))}
              </p>
            )}
            {agents.map((line) => (
              <p key={line} className="np-agent mono">
                {line}
              </p>
            ))}
            {shown?.warnings.map((warning) => (
              <p key={warning} className="np-warning">
                <span className="symbol" aria-hidden="true">
                  !
                </span>
                <span className="visually-hidden">{TEXT.warning}: </span>
                {warning}
              </p>
            ))}
            {blocked?.instead !== undefined && (
              // Why the template can't run is the Start reason below; this offers the way out.
              <p className="np-suggest">
                {TEXT.instead(blocked.instead.name)}{" "}
                <button type="button" className="link" onClick={() => setPicked(blocked.instead!.id)}>
                  {TEXT.use(blocked.instead.name)}
                </button>
              </p>
            )}
            <div className="np-row np-foot">
              <span id={reasonId} className="np-reason">
                {reason}
              </span>
              <button type="submit" className="np-start" disabled={reason !== undefined || busy} aria-describedby={reason !== undefined ? reasonId : undefined}>
                {busy ? TEXT.starting : TEXT.start} <span className="mono np-keys">{isMac() ? "⌘↵" : "Ctrl+↵"}</span>
              </button>
            </div>
            {error !== undefined && (
              <p className="np-error" role="alert">
                <span className="symbol" aria-hidden="true">
                  ✕
                </span>
                {error}
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
