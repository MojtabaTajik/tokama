// Settings > AI CLIs, read-only: each AI CLI Tokama knows, whether it is found and logged in, and
// what Tokama runs for it (arguments, how instructions are passed, environment variable names).
// A list with a filter on the left, the selected CLI on the right. Engine text is rendered as React
// text only, never as HTML.
import type { AiCli, Setup } from "@tokama/core";
import { type ReactNode, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { argLine, stateWords } from "./aiClisText.js";
import { monogram } from "./describe.js";
import { useAiClis } from "./useAiClis.js";

const TEXT = {
  heading: "AI CLIs",
  filter: "Filter CLIs",
  list: "AI CLIs",
  noMatch: "No CLI matches",
  loading: "Loading",
  starting: "Waiting for the engine",
  loadFailed: "Could not load the AI CLIs",
  retry: "Retry",
  checkAgain: "Check again",
  checking: "Checking…",
  login: "How to log in",
  label: "Label",
  launch: "Launch",
  command: "Command",
  commandHint: "Executable Tokama runs.",
  foundAt: "Found at",
  notFound: "Not found on the PATH Tokama passes to it.",
  headless: "Non-interactive args",
  headlessHint: "Run without a terminal and stream events Tokama can read: tool calls, usage, final result.",
  model: "Model arg",
  modelHint: "{model} is replaced with the agent's model.",
  permission: "Permission args",
  permissionHint: "Shown for a read-only step; a step that edits, runs commands or uses the web adds tools and rules. Tokama never adds a skip-all-permissions flag.",
  instructions: "Instructions passed as",
  instructionsHint: "How the step's instructions reach the CLI.",
  promptVia: { stdin: "Step prompt: stdin", argument: "Step prompt: argument" },
  roleVia: "Agent role: argument",
  environment: "Environment and models",
  env: "Environment passed to the CLI",
  envHint: "Names only, never values. Everything else is dropped, including other API keys and SSH agent sockets.",
  usedBy: "Used by",
  usedByNone: "No agent runs on this CLI.",
  unsupported: "Tokama cannot run this CLI yet.",
} as const;

export interface AiClisPageProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly setup: Setup | undefined;
}

export function AiClisPage({ bridge, connection, setup }: AiClisPageProps) {
  const { state, reload } = useAiClis(bridge, connection, setup);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const clis = state.status === "loaded" ? state.data.clis : [];
  const needle = query.trim().toLowerCase();
  const shown = clis.filter((cli) => needle === "" || cli.name.toLowerCase().includes(needle));
  const selected = shown.find((cli) => cli.cliId === selectedId) ?? shown[0];

  return (
    <section className="ai-clis" aria-label={TEXT.heading}>
      <div className="ai-clis-list-pane">
        <input type="text" className="ai-clis-filter" aria-label={TEXT.filter} placeholder="Filter CLIs…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Body state={state} connected={connection.status === "connected"} onRetry={reload} />
        {state.status === "loaded" && (
          <ul className="ai-clis-list" aria-label={TEXT.list}>
            {shown.map((cli) => {
              const words = stateWords(cli);
              return (
                <li key={cli.cliId}>
                  <button type="button" className="ai-cli-row" aria-pressed={cli.cliId === selected?.cliId} onClick={() => setSelectedId(cli.cliId)}>
                    <span className="monogram mono" aria-hidden="true">
                      {monogram(cli.cliId)}
                    </span>
                    <span className="ai-cli-row-name ellipsis">{cli.name}</span>
                    <span className="ai-cli-row-state" data-tone={words.tone} title={words.word} role="img" aria-label={words.word}>
                      {words.symbol}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {state.status === "loaded" && shown.length === 0 && <p className="placeholder">{TEXT.noMatch}</p>}
      </div>
      <div className="ai-cli-detail">{selected === undefined ? null : <Detail cli={selected} checking={state.status === "loaded" && state.checking} onCheck={reload} />}</div>
    </section>
  );
}

function Body({ state, connected, onRetry }: { readonly state: ReturnType<typeof useAiClis>["state"]; readonly connected: boolean; readonly onRetry: () => void }) {
  if (!connected) return <p className="placeholder">{TEXT.starting}</p>;
  if (state.status === "loading") return <p className="placeholder">{TEXT.loading}</p>;
  if (state.status === "loaded") return null;
  return (
    <div className="failure" role="alert">
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          ✕
        </span>
        {TEXT.loadFailed}
      </p>
      <p className="detail">{state.message}</p>
      <button type="button" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </button>
    </div>
  );
}

function Row({ label, hint, children, inline = false }: { readonly label: string; readonly hint?: ReactNode; readonly children: ReactNode; readonly inline?: boolean }) {
  return (
    <div className="ai-cli-row-field" data-inline={inline || undefined}>
      <div className="ai-cli-row-label">
        <h3>{label}</h3>
        {hint !== undefined && <p>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Detail({ cli, checking, onCheck }: { readonly cli: AiCli; readonly checking: boolean; readonly onCheck: () => void }) {
  const words = stateWords(cli);
  return (
    <article aria-label={cli.name}>
      <header className="ai-cli-head">
        <span className="ai-cli-head-icon mono" aria-hidden="true">
          {monogram(cli.cliId)}
        </span>
        <div className="ai-cli-head-text">
          <h2 className="ellipsis">{cli.name}</h2>
          <p className="ai-cli-desc">{cli.description}</p>
          <p className="ai-cli-status">
            <span data-tone={words.tone}>
              <span aria-hidden="true">{words.symbol} </span>
              {words.word}
            </span>
            {cli.supported && cli.version !== undefined && <span className="ai-cli-version">{cli.version}</span>}
            {cli.supported && (
              <button type="button" className="ai-cli-check" disabled={checking} onClick={onCheck}>
                {checking ? TEXT.checking : TEXT.checkAgain}
              </button>
            )}
          </p>
          {cli.supported && cli.state === "not_logged_in" && (
            <p className="ai-cli-login">
              {TEXT.login}: run <code className="mono">{cli.loginCommand}</code> in a terminal, then check again.
            </p>
          )}
          {cli.supported && cli.state !== "not_logged_in" && cli.state !== "ready" && cli.message !== undefined && <p className="ai-cli-login">{cli.message}</p>}
        </div>
      </header>
      {cli.supported ? <Settings cli={cli} /> : <p className="ai-cli-unsupported">{TEXT.unsupported}</p>}
    </article>
  );
}

function Settings({ cli }: { readonly cli: Extract<AiCli, { supported: true }> }) {
  return (
    <>
      <Row label={TEXT.label}>
        <p className="ai-cli-value">{cli.name}</p>
      </Row>
      <h3 className="ai-cli-section">{TEXT.launch}</h3>
      <Row
        label={TEXT.command}
        hint={
          <>
            {TEXT.commandHint} {cli.path === undefined ? TEXT.notFound : <>{TEXT.foundAt} <code className="mono">{cli.path}</code>.</>}
          </>
        }
      >
        <p className="ai-cli-value mono">{cli.command}</p>
      </Row>
      <Row label={TEXT.headless} hint={TEXT.headlessHint}>
        <p className="ai-cli-value mono">{argLine(cli.headlessArgs)}</p>
      </Row>
      <Row label={TEXT.model} hint={TEXT.modelHint}>
        <p className="ai-cli-value mono">{argLine(cli.modelArgs)}</p>
      </Row>
      <Row label={TEXT.permission} hint={TEXT.permissionHint}>
        <p className="ai-cli-value mono">{argLine(cli.permissionArgs)}</p>
      </Row>
      <Row label={TEXT.instructions} hint={TEXT.instructionsHint} inline>
        <div className="ai-cli-value ai-cli-instructions">
          <p>{TEXT.promptVia[cli.promptVia]}</p>
          <p>
            {TEXT.roleVia} <span className="mono">{argLine(cli.roleArgs)}</span>
          </p>
        </div>
      </Row>
      <h3 className="ai-cli-section">{TEXT.environment}</h3>
      <Row label={TEXT.env} hint={TEXT.envHint}>
        <ul className="ai-cli-env mono" aria-label={TEXT.env}>
          {cli.envNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </Row>
      <Row label={TEXT.usedBy}>
        <p className="ai-cli-value">{cli.usedBy.length === 0 ? TEXT.usedByNone : cli.usedBy.join(" · ")}</p>
      </Row>
    </>
  );
}
