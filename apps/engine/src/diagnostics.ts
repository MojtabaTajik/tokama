// The engine's diagnostics: opens the store in the Tokama home, keeps what the redactor must know
// (repos, home folders, Tokama's own code), answers the diagnostics queries and commands, and
// counts the commands that are usage. Real mode only: the store is opened under the home lock.
import { userInfo } from "node:os";
import { basename } from "node:path";
import {
  type CliHealth,
  type Command,
  type CommandErrorCode,
  DiagnosticsStore,
  diagnosticsDirOf,
  type DiagnosticsListResult,
  type DiagnosticsSettingsResult,
  type Clock,
  loadRepos,
  type MachineFacts,
  type Query,
  readMachineFacts,
  type RedactionContext,
  type Repo,
  REQUEST_CHANGES_ID,
  type UsageAction,
} from "@tokama/core";

type ReplyResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** How often the day's usage counts are written while the engine runs. */
const USAGE_FLUSH_MS = 10 * 60 * 1000;

export interface DiagnosticsOptions {
  /** Tokama's home; the store is `<home>/diagnostics`. */
  readonly home: string;
  /** The user's home folder, cleaned from stacks as a path; its last part as the login name too. */
  readonly userHome: string;
  /** Folders of Tokama's own code, whose built files stacks may name. */
  readonly codeRoots: readonly string[];
  readonly engineVersion: string;
  /** Default: read from this machine. */
  readonly machine?: MachineFacts;
  readonly clock: Clock;
  readonly onChange: () => void;
  /** Called when entries are recorded or deleted. */
  readonly onEntries?: () => void;
  readonly log: (message: string) => void;
}

export class EngineDiagnostics {
  private readonly timer: ReturnType<typeof setInterval>;

  private constructor(
    readonly store: DiagnosticsStore,
    private readonly home: string,
    /** The repos the redactor knows; shared with the store's redaction context. */
    private readonly known: { repos: readonly Repo[] },
  ) {
    this.timer = setInterval(() => store.flushUsage(), USAGE_FLUSH_MS);
    this.timer.unref();
  }

  static async open(options: DiagnosticsOptions): Promise<EngineDiagnostics> {
    const userName = loginName(options.userHome);
    const known: { repos: readonly Repo[] } = { repos: [] };
    const context = (): RedactionContext => ({
      codeRoots: options.codeRoots,
      paths: [options.userHome, options.home, ...known.repos.map((repo) => repo.path)],
      repoNames: known.repos.flatMap((repo) => [repo.id, basename(repo.path)]),
      ...(userName === undefined ? {} : { userName }),
    });
    const store = await DiagnosticsStore.open({
      dir: diagnosticsDirOf(options.home),
      engineVersion: options.engineVersion,
      machine: options.machine ?? (await readMachineFacts()),
      redaction: context,
      clock: options.clock,
      onChange: options.onChange,
      ...(options.onEntries !== undefined && { onEntries: options.onEntries }),
      log: options.log,
    });
    const diagnostics = new EngineDiagnostics(store, options.home, known);
    await diagnostics.refreshRepos();
    return diagnostics;
  }

  /** Reads repos.yaml again, so new repo names and folders are cleaned from then on. */
  async refreshRepos(): Promise<void> {
    const loaded = await loadRepos({ tokamaHome: this.home });
    if (loaded.ok) this.known.repos = loaded.value;
  }

  setClis(clis: readonly CliHealth[]): void {
    this.store.setClis(clis.filter((cli) => cli.installed).map((cli) => ({ cliId: cli.cliId, version: cli.version })));
  }

  query(query: Extract<Query, { type: "diagnostics_list" | "diagnostics_settings" }>): ReplyResult {
    if (query.type === "diagnostics_settings") return { ok: true, data: this.store.settings() satisfies DiagnosticsSettingsResult };
    const { types, since, until, limit } = query;
    return {
      ok: true,
      data: this.store.list({ ...(types && { types }), ...(since !== undefined && { since }), ...(until !== undefined && { until }), ...(limit !== undefined && { limit }) }) satisfies DiagnosticsListResult,
    };
  }

  command(command: DiagnosticsCommand): ReplyResult {
    switch (command.type) {
      case "diagnostics_delete": {
        if ((command.ids === undefined) === (command.all === undefined)) {
          return { ok: false, error: { code: "invalid_request" satisfies CommandErrorCode, message: "give either ids or all, not both" } };
        }
        return { ok: true, data: { deleted: this.store.delete(command.all ? { all: true } : { ids: command.ids ?? [] }) } };
      }
      case "diagnostics_settings": {
        const { collect, resetInstallId, crashSeen } = command;
        return { ok: true, data: this.store.updateSettings({ ...(collect !== undefined && { collect }), ...(resetInstallId && { resetInstallId }), ...(crashSeen && { crashSeen }) }) satisfies DiagnosticsSettingsResult };
      }
      case "report_diagnostic":
        this.store.report(command.report, command.appVersion);
        return { ok: true, data: null };
    }
  }

  /** Counts a command that succeeded, by its action alone. */
  countCommand(command: Command, item: (id: string) => { kind: string } | undefined, data: unknown): void {
    const action = usageAction(command, item, data);
    if (action !== undefined) this.store.count(action);
  }

  close(): void {
    clearInterval(this.timer);
    this.store.close();
  }
}

export type DiagnosticsCommand = Extract<Command, { type: "diagnostics_delete" | "diagnostics_settings" | "report_diagnostic" }>;

export const isDiagnosticsCommand = (command: Command): command is DiagnosticsCommand =>
  command.type === "diagnostics_delete" || command.type === "diagnostics_settings" || command.type === "report_diagnostic";


/** The usage action of a command; undefined for one that is not counted. */
export function usageAction(command: Command, item: (id: string) => { kind: string } | undefined, data: unknown): UsageAction | undefined {
  switch (command.type) {
    case "start_item": {
      const id = typeof data === "object" && data !== null && "itemId" in data && typeof data.itemId === "string" ? data.itemId : undefined;
      const kind = id === undefined ? undefined : item(id)?.kind;
      return kind === "investigation" ? "start_investigation" : kind === "task" ? "start_task" : undefined;
    }
    case "resolve_decision":
      return command.choice === "approve" ? "approve" : command.choice === REQUEST_CHANGES_ID ? "request_changes" : "answer_decision";
    case "stop_item":
      return "stop_item";
    case "finish_item":
      return `finish_${command.action}`;
    case "accept_git_changes":
      return "accept_git_changes";
    case "add_repo":
      return "add_repo";
    case "remove_repo":
      return "remove_repo";
    default:
      return undefined;
  }
}

function loginName(userHome: string): string | undefined {
  try {
    return userInfo().username;
  } catch {
    const name = basename(userHome);
    return name === "" ? undefined : name;
  }
}
