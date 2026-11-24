// The New work input, floating at the bottom of the main area. A single line until it is focused;
// then it expands upward with the Template and Repos dropdowns, what the template uses, its steps
// on one line, the one run option and Start (Cmd or Ctrl and Enter). Start sends `start_item` and
// hands the new item's id up. Engine text (names, error messages) renders as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import { type FormEvent, type KeyboardEvent, type Ref, useId, useImperativeHandle, useRef, useState } from "react";
import { BRIDGE_ERROR_CODES, type TokamaBridge } from "../../shared/bridge.js";
import { KIND_GROUPS, missing, needsRepo, stepsLine, usesOf } from "./needs.js";
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
  askBeforeCloud: "Ask before cloud steps",
  start: "Start",
  starting: "Starting…",
  notConnected: "Not connected to the engine. Try again when it is back.",
  failed: (message: string) => `Could not start the work: ${message}`,
} as const;

const SHORTCUT = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘↵" : "Ctrl+↵";
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
  /** The engine accepted the work: what the new item is and where it belongs. */
  readonly onStarted: (itemId: string, started: Pick<ItemRecord, "templateId" | "repoIds">) => void;
}

export function NewWork({ bridge, setup, ref, onStarted }: NewWorkProps) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [repoIds, setRepoIds] = useState<readonly string[]>([]);
  const [askBeforeCloud, setAskBeforeCloud] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  // What had focus before the input took it: Escape gives it back.
  const origin = useRef<HTMLElement | undefined>(undefined);
  const reasonId = useId();

  const suggestedId = useSuggestion(bridge, text);
  // The user's own choice wins; until then the engine's suggestion applies.
  const template = setup.templates.find((candidate) => candidate.id === (picked ?? suggestedId));
  const reason = missing({ template, text, repoIds });
  // In the setup's order; a repo that left the setup since it was chosen drops out.
  const chosenRepos = setup.repos.filter((repo) => repoIds.includes(repo.id)).map((repo) => repo.id);

  useImperativeHandle(ref, () => ({
    open(prefill) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== input.current) origin.current = active;
      if (prefill?.templateId !== undefined) setPicked(prefill.templateId);
      if (prefill?.repoId !== undefined) setRepoIds([prefill.repoId]);
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
    // Always sent: the engine's own default for a missing option is to ask.
    const command = { type: "start_item", templateId: template.id, repoIds: chosenRepos, text: text.trim(), options: { askBeforeCloud } } as const;
    const reply = await bridge.command(command).catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    setBusy(false);
    if (!reply.ok) {
      setError(reply.error.code === BRIDGE_ERROR_CODES.notConnected ? TEXT.notConnected : TEXT.failed(reply.error.message));
      return;
    }
    setText("");
    setPicked(undefined);
    setRepoIds([]);
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

  const toggleRepo = (id: string) => setRepoIds(repoIds.includes(id) ? repoIds.filter((repoId) => repoId !== id) : [...repoIds, id]);
  const uses = template ? usesOf(template, setup.connections) : [];

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
                summary={template ? `${template.name}${picked === undefined ? ` (${TEXT.suggested})` : ""}` : TEXT.chooseTemplate}
                searchLabel={TEXT.searchTemplates}
                multi={false}
                selected={new Set(template ? [template.id] : [])}
                groups={KIND_GROUPS.map(({ kind, heading }) => ({
                  heading,
                  options: setup.templates.filter((candidate) => candidate.kind === kind).map((candidate) => ({ id: candidate.id, label: candidate.name, tag: candidate.id === suggestedId ? TEXT.suggested : undefined })),
                }))}
                onPick={setPicked}
              />
              <Picker
                label={TEXT.repos}
                summary={chosenRepos.length === 0 ? (template === undefined || needsRepo(template) ? TEXT.chooseRepos : TEXT.optional) : chosenRepos.length === 1 ? (chosenRepos[0] ?? "") : TEXT.repoCount(chosenRepos.length)}
                searchLabel={TEXT.searchRepos}
                multi
                selected={new Set(chosenRepos)}
                groups={[{ options: setup.repos.map((repo) => ({ id: repo.id, label: repo.id })) }]}
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
            {template && (
              <p className="np-steps mono ellipsis" title={stepsLine(template, setup.agents)}>
                <span className="visually-hidden">{TEXT.steps}: </span>
                {stepsLine(template, setup.agents)}
              </p>
            )}
            <div className="np-row np-foot">
              <label className="np-option-label">
                <input type="checkbox" checked={askBeforeCloud} onChange={(event) => setAskBeforeCloud(event.target.checked)} /> {TEXT.askBeforeCloud}
              </label>
              <span id={reasonId} className="np-reason">
                {reason}
              </span>
              <button type="submit" className="np-start" disabled={reason !== undefined || busy} aria-describedby={reason !== undefined ? reasonId : undefined}>
                {busy ? TEXT.starting : TEXT.start} <span className="mono np-keys">{SHORTCUT}</span>
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
