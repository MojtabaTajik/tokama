// The Templates page, read-only: every template file the engine finds (each repo's and the
// built-ins), and the selected one: its problems with line numbers, the file, Start, what it can
// use, the flow, each step as one sentence, and Finish. Files are changed in the editor; the page
// reads them again when the window gets focus back. Engine and file text render as text only.
import type { ConnectionSummary, AgentSummary, TemplateDetail, TemplateEntry, TemplateFileKey } from "@tokama/core";
import { useId, useMemo, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { budgetText, FINISH, placeOf, startSentence, statusOf, stepSentence, titleOf, usesOf } from "./describe.js";
import { flowOf } from "./flow.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { keyId, useReload, useTemplateDetail, useTemplateList } from "./useTemplates.js";
import { Button } from "../ui/Button.js";
import { Section, SectionList } from "../ui/Section.js";
import { markOf } from "../ui/status.js";
import { agentDot, AgentDotMark } from "../ui/agent.js";

const FAIL = markOf("failed").symbol;

const TEXT = {
  title: "Templates",
  intro: "Templates are YAML files in your repos’ .tokama/templates/ folders. Edit them in your editor; Tokama reads them again when you come back.",
  filter: "Filter templates",
  list: "Template files",
  loading: "Loading templates",
  none: "No templates found",
  noMatch: "No template matches the filter",
  checkAgain: "Check again",
  pick: "Pick a template to see it.",
  from: "From",
  builtin: "Ships with Tokama.",
  readOnly: "Read-only here: change the file and Tokama checks it again.",
  open: "Open in editor",
  noFile: "There is no file on this machine to open.",
  tooLarge: "The file is too large to show here; open it in your editor.",
  file: "File",
  cannotUse: "New work can’t use this template until the file is fixed.",
  warnings: "Worth knowing",
  start: "Start",
  canUse: "Can use",
  canUseNote: "Anything outside the item’s own worktree asks you first.",
  repos: "Repos",
  connections: "Connections",
  commands: "Commands",
  none_: "none",
  flow: "Flow",
  flowNote: "read-only · from the file",
  steps: "Steps",
  finish: "You get at the end",
  budget: "budget",
  line: (n: number) => `line ${n}`,
} as const;

export interface TemplatesPageProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly agents: readonly AgentSummary[];
  readonly connections: readonly ConnectionSummary[];
}

export function TemplatesPage({ bridge, connection, agents, connections }: TemplatesPageProps) {
  const [reload, checkAgain] = useReload(bridge);
  const list = useTemplateList(bridge, connection, reload);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<TemplateFileKey | undefined>(undefined);
  const entries = list.state === "ready" ? list.value : [];
  // The picked file while it is still there, else the first one.
  const selected = (picked !== undefined ? entries.find((entry) => keyId(entry) === keyId(picked)) : undefined) ?? entries[0];
  const detail = useTemplateDetail(bridge, connection, selected, reload);
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return words === "" ? entries : entries.filter((entry) => `${titleOf(entry)} ${placeOf(entry)}`.toLowerCase().includes(words));
  }, [entries, filter]);
  const repos = new Set(entries.filter((entry) => entry.origin !== "builtin").map((entry) => entry.origin)).size;
  const builtins = entries.filter((entry) => entry.origin === "builtin").length;

  return (
    <>
      <section className="tp-list" aria-label={TEXT.title}>
        <h2 className="settings-heading">{TEXT.title}</h2>
        <p className="tp-intro">{TEXT.intro}</p>
        <input type="search" className="tp-filter" placeholder={`${TEXT.filter}…`} aria-label={TEXT.filter} value={filter} onChange={(event) => setFilter(event.target.value)} />
        {list.state === "loading" && <p className="tp-quiet">{TEXT.loading}</p>}
        {list.state === "failed" && <p className="tp-quiet" role="alert">{`${FAIL} ${list.message}`}</p>}
        {list.state === "ready" && entries.length === 0 && <p className="tp-quiet">{TEXT.none}</p>}
        {list.state === "ready" && entries.length > 0 && shown.length === 0 && <p className="tp-quiet">{TEXT.noMatch}</p>}
        <ul className="tp-rows" aria-label={TEXT.list}>
          {shown.map((entry) => (
            <li key={keyId(entry)}>
              <EntryRow entry={entry} selected={selected !== undefined && keyId(entry) === keyId(selected)} onPick={() => setPicked({ origin: entry.origin, file: entry.file })} />
            </li>
          ))}
        </ul>
        <div className="tp-list-foot">
          {list.state === "ready" && <span>{countText(entries.length, repos, builtins)}</span>}
          <Button variant="link" className="tp-link" onClick={checkAgain}>
            {TEXT.checkAgain}
          </Button>
        </div>
      </section>
      <main className="tp-detail" aria-label={selected === undefined ? TEXT.title : titleOf(selected)}>
        {selected === undefined || detail === undefined ? (
          list.state === "ready" && entries.length > 0 && <p className="tp-quiet">{TEXT.pick}</p>
        ) : detail.state === "loading" ? (
          <p className="tp-quiet">{TEXT.loading}</p>
        ) : detail.state === "failed" ? (
          <p className="tp-quiet" role="alert">{`${FAIL} ${detail.message}`}</p>
        ) : (
          <Detail key={keyId(selected)} bridge={bridge} detail={detail.value} agents={agents} connections={connections} />
        )}
      </main>
    </>
  );
}

function countText(count: number, repos: number, builtins: number): string {
  const files = count === 1 ? "1 template" : `${count} templates`;
  const from = [repos > 0 ? (repos === 1 ? "1 repo" : `${repos} repos`) : "", builtins > 0 ? "built-in" : ""].filter(Boolean).join(" and ");
  return from === "" ? files : `${files} from ${from}.`;
}

function Status({ entry }: { readonly entry: Pick<TemplateEntry, "problemCount"> }) {
  const status = statusOf(entry);
  return <span className="tp-status" data-tone={status.tone}>{`${status.symbol} ${status.word}`}</span>;
}

function EntryRow({ entry, selected, onPick }: { readonly entry: TemplateEntry; readonly selected: boolean; readonly onPick: () => void }) {
  return (
    <Button variant="plain" className="tp-row" aria-pressed={selected} onClick={onPick}>
      <TemplateIcon icon={entry.icon} color={entry.color} size={14} />
      <span className="tp-row-name ellipsis">{titleOf(entry)}</span>
      <Status entry={entry} />
      <span className="tp-row-place mono">{placeOf(entry)}</span>
    </Button>
  );
}

interface DetailProps {
  readonly bridge: TokamaBridge;
  readonly detail: TemplateDetail;
  readonly agents: readonly AgentSummary[];
  readonly connections: readonly ConnectionSummary[];
}

function Detail({ bridge, detail, agents, connections }: DetailProps) {
  const { entry, template, problems, warnings, text, textTooLarge } = detail;
  const fileId = useId();
  const [fileOpen, setFileOpen] = useState(false);
  const [mark, setMark] = useState<number | undefined>(undefined);
  const [openNote, setOpenNote] = useState<string | undefined>(undefined);
  const showLine = (line: number) => {
    setFileOpen(true);
    setMark(line);
    // After the file is drawn: bring the line into view.
    requestAnimationFrame(() => document.getElementById(`${fileId}-${line}`)?.scrollIntoView({ block: "center" }));
  };
  const open = async () => {
    setOpenNote(undefined);
    const result = await bridge.openTemplateFile({ origin: entry.origin, file: entry.file }).catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (!result.ok) setOpenNote(`${FAIL} ${result.message}`);
  };
  const flow = useMemo(() => (template === null ? undefined : flowOf(template, agents)), [template, agents]);
  const uses = template === null ? undefined : usesOf(template, connections);

  return (
    <div className="tp-body">
      <header className="tp-head">
        <span className="tp-head-icon">
          <TemplateIcon icon={entry.icon} color={entry.color} size={20} />
        </span>
        <div className="tp-head-text">
          <h1>{titleOf(entry)}</h1>
          {template?.budget !== undefined && (
            <span className="tp-quiet">
              {TEXT.budget} <span className="mono">{budgetText(template.budget.timeMinutes)}</span>
            </span>
          )}
          <Status entry={entry} />
        </div>
      </header>
      <p className="tp-source">
        {entry.origin === "builtin" ? (
          TEXT.builtin
        ) : (
          <>
            {TEXT.from} <code className="mono">{placeOf(entry)}</code>. {TEXT.readOnly}
          </>
        )}
      </p>
      <div className="tp-actions">
        {entry.openable ? (
          <Button variant="link" className="tp-link" onClick={() => void open()}>
            {TEXT.open}
          </Button>
        ) : (
          entry.origin !== "builtin" && <span className="tp-quiet">{TEXT.noFile}</span>
        )}
        {textTooLarge && <span className="tp-quiet">{TEXT.tooLarge}</span>}
        {openNote !== undefined && (
          <span className="tp-open-note" role="alert">
            {openNote}
          </span>
        )}
      </div>

      {problems.length > 0 && (
        <section className="tp-section" aria-label={statusOf(entry).word}>
          <h2 className="tp-problems-title">{`${FAIL} ${statusOf(entry).word}`}</h2>
          <p className="tp-quiet">{TEXT.cannotUse}</p>
          <ul className="tp-problems">
            {problems.map((problem, index) => (
              <li key={`${problem.line}-${index}`}>
                {text !== null ? (
                  <Button variant="link" className="tp-link mono" onClick={() => showLine(problem.line)}>
                    {TEXT.line(problem.line)}
                  </Button>
                ) : (
                  <span className="mono">{TEXT.line(problem.line)}</span>
                )}
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {text !== null && (
        <SectionList>
          <Section title={TEXT.file} facts={entry.file.split("/").at(-1)} open={fileOpen} onToggle={() => setFileOpen(!fileOpen)}>
            {() => <FileText id={fileId} text={text} problemLines={new Set(problems.map((problem) => problem.line))} mark={mark} />}
          </Section>
        </SectionList>
      )}

      {warnings.length > 0 && (
        <section className="tp-section" aria-label={TEXT.warnings}>
          <h2>{TEXT.warnings}</h2>
          <ul className="tp-warnings">
            {warnings.map((warning) => (
              <li key={warning}>
                <span aria-hidden="true">!</span> {warning}
              </li>
            ))}
          </ul>
        </section>
      )}

      {template !== null && uses !== undefined && flow !== undefined && (
        <>
          <section className="tp-section" aria-label={TEXT.start}>
            <h2>{TEXT.start}</h2>
            <p>{startSentence(template)}</p>
          </section>
          <section className="tp-section" aria-label={TEXT.canUse}>
            <h2>
              {TEXT.canUse} <span className="tp-quiet">{TEXT.canUseNote}</span>
            </h2>
            <dl className="tp-uses">
              <dt>{TEXT.repos}</dt>
              <dd>{uses.repos.length === 0 ? TEXT.none_ : uses.repos.map((repo) => <span key={repo.name}>{`${repo.name} · ${repo.detail}`}</span>)}</dd>
              <dt>{TEXT.connections}</dt>
              <dd>{uses.connections.length === 0 ? TEXT.none_ : uses.connections.map((use) => <span key={use.name}>{`${use.name} · ${use.detail}`}</span>)}</dd>
              <dt>{TEXT.commands}</dt>
              <dd>
                {uses.commands.length === 0
                  ? TEXT.none_
                  : uses.commands.map((command) => (
                      <code key={command} className="mono">
                        {command}
                      </code>
                    ))}
              </dd>
            </dl>
          </section>
          <section className="tp-section" aria-label={TEXT.flow}>
            <h2>
              {TEXT.flow} <span className="tp-quiet">{TEXT.flowNote}</span>
            </h2>
            <FlowDiagram flow={flow} />
          </section>
          <section className="tp-section" aria-label={TEXT.steps}>
            <h2>{TEXT.steps}</h2>
            <ol className="tp-steps">
              {template.steps.map((step, index) => {
                const dot = agentDot(step.agentId, agents);
                return (
                  <li key={step.id}>
                    <span className="tp-step-n mono">{index + 1}</span>
                    <span>
                      <AgentDotMark dot={dot} />
                      <strong>{step.name}</strong>: {stepSentence(step, template, agents, connections)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className="tp-section" aria-label={TEXT.finish}>
            <h2>{TEXT.finish}</h2>
            <ul className="tp-finish">
              {template.finish.map((finish) => (
                <li key={finish}>
                  <span aria-hidden="true">{markOf("passed").symbol}</span>
                  <span>
                    <strong>{FINISH[finish].name}</strong> · {FINISH[finish].text}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/** The file with line numbers; lines with a problem carry ✕. Plain text, never markup. */
function FileText({ id, text, problemLines, mark }: { readonly id: string; readonly text: string; readonly problemLines: ReadonlySet<number>; readonly mark: number | undefined }) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return (
    <div className="tp-file mono" id={id} tabIndex={0} aria-label={`${TEXT.file}, ${lines.length} lines`}>
      {lines.map((line, index) => {
        const n = index + 1;
        const bad = problemLines.has(n);
        return (
          <div key={n} id={`${id}-${n}`} className="tp-file-line" data-problem={bad || undefined} data-mark={mark === n || undefined}>
            <span className="tp-file-n">{n}</span>
            <span className="tp-file-flag">{bad ? markOf("failed").symbol : ""}</span>
            <span className="tp-file-text">{line}</span>
          </div>
        );
      })}
    </div>
  );
}
