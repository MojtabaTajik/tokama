// The repo dialog. Add: after the folder picker, the engine's suggestions for the folder (id, base
// branch, checks) as editable fields, then Add. A folder that is no git repo yet, or a repo with
// no commit, offers to set git up and make a first commit, showing what the commit will hold.
// Under the Checks field, two helpers: Suggest with AI and Try checks (ChecksHelpers.tsx). Edit: from a repo row's menu, the repo's base branch and checks, with its id fixed, then Save.
// The engine checks every field again and answers a refusal in plain words, shown here. Engine
// text is rendered as React text only.
import type { CommandInput, InitRepoResult, RepoBranchesResult, RepoSummary, SuggestRepoResult } from "@tokama/core";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { DialogFrame, Modal } from "../ui/Modal.js";
import { Problem } from "./Problem.js";
import { Button } from "../ui/Button.js";
import { Combobox, type ComboboxGroup } from "../ui/Combobox.js";
import { markOf, StatusMark } from "../ui/status.js";
import { ChecksHelpersRow, SuggestInBox } from "./ChecksHelpers.js";
import { checkLines } from "./checks-model.js";
import { useChecksHelpers } from "./useChecksHelpers.js";

const TEXT = {
  title: "Add repo",
  editTitle: "Edit repo",
  settingUp: "Setting up git",
  reading: "Reading the folder…",
  id: "Id",
  idHint: "How Tokama names the repo: lowercase letters, digits and hyphens.",
  idFromFolder: "From the folder name.",
  idFixed: "Items and worktrees use the id. To rename, remove the repo and add it again.",
  readOnly: "read-only",
  baseBranch: "Base branch",
  baseBranchHint: "Work branches start from it. Preselected: the repo's default branch. Pick another or type a name.",
  baseBranchOnlyHint: "The only branch here, so it is the default.",
  baseBranchEditHint: "New work branches start from it. Running items keep their branch.",
  branches: "Branches",
  searchBranches: "Search branches or type a name",
  searchBranchesPlaceholder: "Search branches",
  otherBranches: "Other branches",
  defaultTag: "default",
  useBranch: (text: string) => `Use ‘${text}’`,
  branchesCut: (shown: number, all: number) => `Showing the first ${shown} of ${all} branches.`,
  typeBranch: "Type a branch name to use one that isn't listed.",
  branchKeys: "↑ ↓ move · Enter choose · Esc close",
  checks: "Checks",
  checksHint: "One command per line, run in the repo after each change. No &&, | or redirects. Check commands and their output can go to a cloud agent whose step sends the repo and diff.",
  checksFound: (scripts: string) => `Found in package.json scripts: ${scripts}.`,
  suggested: "suggested",
  noneFound: "none found",
  add: "Add repo",
  adding: "Adding…",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  working: "Working…",
  failed: (message: string) => `Could not add it: ${message}`,
  saveFailed: (message: string) => `Could not save it: ${message}`,
  noChecks: "No checks found in this folder.",
  noChecksWhy: "Tokama runs these after each change. Quick fix needs at least one. Templates where you approve the change, like Quick change, work without checks.",
  fromPackageMain: (file: string) => `${file} is the "main" in package.json`,
  setUpGit: "Set up git and add",
  firstCommit: "Make a first commit and add",
  pickAnother: "Pick another folder",
  notARepo: "This folder isn't a git repo yet.",
  setUpIntro: "Set up git and add does three things in this folder, then adds the repo:",
  gitInitOn: "on branch",
  writesGitignore: "for Node and macOS",
  makesCommit: "makes a first commit,",
  noCommits: "This repo has no commits yet. Tokama starts each piece of work on a branch from a commit. Make a first commit of what is here now, on branch",
  firstCommitHeading: "First commit",
  existingGitignore: "uses your existing .gitignore",
  more: (rest: number) => `and ${rest} more`,
  leftOut: "Left out by the new .gitignore",
  leftOutNote: ".env stays on disk and is never committed. Edit .gitignore later like any file.",
  manyFiles: "many files",
  stepFailed: { init: "Setting up git failed.", commit: "The first commit failed.", add: "Adding the repo failed." },
  folderNow: (parts: string) => `The folder now has ${parts}; nothing else changed.`,
  tryAgain: "Try again",
} as const;

export interface SetUpNote {
  readonly id: string;
  readonly commit: string;
  /** 0 when the repo had its commit already. */
  readonly files: number;
}

export type RepoDialogProps = {
  readonly bridge: TokamaBridge;
  readonly onClose: () => void;
  /** After git was set up and the repo added. */
  readonly onSetUp?: (note: SetUpNote) => void;
  /** From a refusal: closes this dialog and opens the folder picker again. */
  readonly onPickAnother?: () => void;
  /** From the line that says no AI CLI is ready: closes this dialog and opens the Get started list. */
  readonly onOpenGetStarted?: () => void;
} & (
  | { /** The folder the picker returned: adds a repo. */ readonly path: string; readonly repo?: undefined }
  | { /** The repo to change: edits it. */ readonly repo: RepoSummary; readonly path?: undefined }
);

type Loaded = { readonly ok: true; readonly suggestion: SuggestRepoResult } | { readonly ok: false; readonly message: string };
type Phase = "init" | "commit" | "add";
interface Failure {
  readonly phase: Phase;
  readonly message: string;
}

const bridgeFailure = (cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } });

/** A size for the file list: whole KB, at least 1 KB; MB from 1 MB. */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export function RepoDialog({ bridge, path, repo, onClose, onSetUp, onPickAnother, onOpenGetStarted }: RepoDialogProps) {
  const titleId = useId();
  const editing = repo !== undefined;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [id, setId] = useState(repo?.id ?? "");
  const [baseBranch, setBaseBranch] = useState(repo?.baseBranch ?? "");
  const [checks, setChecks] = useState(repo?.checks.join("\n") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [initResult, setInitResult] = useState<InitRepoResult | undefined>(undefined);
  // Edit: the repo's branches, once the engine answers. Until then, or when it cannot, the field takes typed text only.
  const [editBranches, setEditBranches] = useState<RepoBranchesResult | undefined>(undefined);
  const repoId = repo?.id;

  useEffect(() => {
    if (repoId === undefined) return;
    let live = true;
    void bridge
      .query({ type: "repo_branches", repoId })
      .catch(bridgeFailure)
      .then((reply) => {
        if (live && reply.ok) setEditBranches(reply.data);
      });
    return () => {
      live = false;
    };
  }, [bridge, repoId]);

  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    void bridge
      .query({ type: "suggest_repo", path })
      .catch(bridgeFailure)
      .then((reply) => {
        if (!live) return;
        if (!reply.ok) return setLoaded({ ok: false, message: reply.error.message });
        setLoaded({ ok: true, suggestion: reply.data });
        setId(reply.data.id ?? "");
        setBaseBranch(reply.data.defaultBranch ?? reply.data.branch ?? (reply.data.firstCommit === null ? "" : "main"));
        setChecks(reply.data.checks.join("\n"));
      });
    return () => {
      live = false;
    };
  }, [bridge, path]);

  const suggestion = loaded?.ok ? loaded.suggestion : undefined;
  const firstCommit = suggestion?.firstCommit ?? null;
  const refused = firstCommit?.refusal ?? null;
  // The folder can be set up here: the commit is allowed and shown.
  const settingUp = firstCommit !== null && refused === null;
  const canAdd = editing || (suggestion !== undefined && suggestion.problem === null);
  const lines = checks.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const fallback = suggestion?.fallbackCheck ?? null;
  const hadChecks = (suggestion?.checks.length ?? 0) > 0;
  // The helpers work on the repo's folder as the engine can open it. Try checks needs a commit to start its worktree from.
  const helpers = useChecksHelpers({
    bridge,
    path: editing ? repo.path : suggestion?.path,
    baseBranch,
    checks,
    canTry: editing || (suggestion?.gitRepo === true && suggestion.hasCommits),
  });
  /** Suggested commands go on new lines at the end of the field, where they stay editable. */
  const addChecks = (commands: readonly string[]) =>
    setChecks((before) => {
      const have = new Set(checkLines(before));
      const fresh = commands.filter((command) => !have.has(command));
      const kept = before.replace(/\s+$/, "");
      return fresh.length === 0 ? before : `${kept === "" ? "" : `${kept}\n`}${fresh.join("\n")}`;
    });
  // With nothing in the field and nothing asked yet, Suggest with AI sits in the "No checks found" box, where Try checks would have nothing to run.
  const suggestInBox = lines.length === 0 && helpers.suggest.kind === "idle" && helpers.trial.kind === "idle";
  const helpersOffered = helpers.canTry || (helpers.loaded && helpers.availability !== undefined) || helpers.suggest.kind !== "idle" || helpers.trial.kind !== "idle";

  /** The add_repo or update_repo command for what the fields hold now. */
  const saveCommand = (): CommandInput =>
    repo !== undefined
      ? { type: "update_repo", repoId: repo.id, baseBranch: baseBranch.trim(), checks: lines }
      : {
          type: "add_repo",
          path: suggestion!.path,
          ...(id.trim() === "" ? {} : { id: id.trim() }),
          ...(baseBranch.trim() === "" ? {} : { baseBranch: baseBranch.trim() }),
          checks: lines,
        };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd || busy) return;
    setBusy(true);
    setError(undefined);
    const reply = await bridge.command(saveCommand()).catch(bridgeFailure);
    setBusy(false);
    if (reply.ok) onClose();
    else setError((editing ? TEXT.saveFailed : TEXT.failed)(reply.error.message));
  };

  /** Git init and .gitignore, the first commit, then the add: each step shows as it runs. */
  const setUp = async () => {
    if (suggestion === undefined || !settingUp || busy) return;
    setBusy(true);
    setFailure(undefined);
    const fail = (at: Phase, message: string) => {
      setFailure({ phase: at, message });
      setBusy(false);
    };
    setPhase("init");
    const init = await bridge.command({ type: "init_repo", path: suggestion.path, ...(suggestion.gitRepo || baseBranch.trim() === "" ? {} : { baseBranch: baseBranch.trim() }) }).catch(bridgeFailure);
    if (!init.ok) return fail("init", init.error.message);
    setInitResult((before) => ({ gitInit: before?.gitInit === true || init.data.gitInit, ignoreRules: before?.ignoreRules ?? init.data.ignoreRules }));
    setPhase("commit");
    const commit = await bridge.command({ type: "first_commit", path: suggestion.path }).catch(bridgeFailure);
    if (!commit.ok) return fail("commit", commit.error.message);
    setPhase("add");
    const added = await bridge.command(saveCommand()).catch(bridgeFailure);
    if (!added.ok) {
      // The folder is a repo with a commit now: the form takes over, and the error shows there.
      setPhase(undefined);
      setBusy(false);
      setError(TEXT.failed(added.error.message));
      return;
    }
    setBusy(false);
    onClose();
    onSetUp?.({ id: id.trim() || suggestion.id || "", commit: commit.data.commit, files: commit.data.files });
  };

  // Set-up runs on once started: the dialog stays until it ends.
  const close = () => {
    if (!busy) onClose();
  };
  const branchName = baseBranch.trim() || suggestion?.branch || "main";
  const cancel = (
    <Button variant="secondary" onClick={close}>
      {TEXT.cancel}
    </Button>
  );

  // The working view replaces the form while git is set up, and stays for a failure.
  if (phase !== undefined) {
    type Key = "init" | "ignore" | "commit" | "add";
    const keys: Key[] = [
      ...(suggestion?.gitRepo === false ? (["init"] as const) : []),
      ...(firstCommit?.addsGitignore === true ? (["ignore"] as const) : []),
      "commit",
      "add",
    ];
    const activeKey: Key = phase === "init" ? keys[0]! : phase;
    const stateOf = (key: Key): "done" | "active" | "todo" =>
      failure !== undefined && failure.phase === phase && key === activeKey ? "todo" : keys.indexOf(key) < keys.indexOf(activeKey) ? "done" : key === activeKey ? "active" : "todo";
    const labels: Record<Key, ReactNode> = {
      init: (
        <>
          <span className="mono">git init</span> <span className="rd-dim">· branch {branchName}</span>
        </>
      ),
      ignore: (
        <>
          {initResult === undefined ? "Write" : "Wrote"} <span className="mono">.gitignore</span>
          {initResult?.ignoreRules != null && <span className="rd-dim"> · {plural(initResult.ignoreRules, "rule")}</span>}
        </>
      ),
      commit: (
        <>
          First commit {firstCommit !== null && <span className="rd-dim">· {plural(firstCommit.files, "file")}</span>}
        </>
      ),
      add: <>Add repo</>,
    };
    const left = [initResult?.gitInit === true && "a .git folder", initResult?.ignoreRules != null && "a .gitignore"].filter((part) => part !== false).join(" and ");
    return (
      <Modal labelledBy={titleId} onClose={close}>
        <DialogFrame
          titleId={titleId}
          title={TEXT.settingUp}
          subtitle={suggestion?.displayPath}
          onClose={close}
          footer={failure === undefined ? <Button variant="secondary" disabled>{TEXT.working}</Button> : cancel}
        >
          <ol className="rd-steps" aria-live="polite">
            {keys.map((key) => {
              const state = stateOf(key);
              const failed = failure !== undefined && failure.phase === phase && key === activeKey;
              return (
                <li key={key} data-state={failed ? "failed" : state}>
                  <span className="rd-mark" aria-hidden="true">
                    {markOf(failed ? "failed" : state === "done" ? "done" : state === "active" ? "running" : "pending").symbol}
                  </span>
                  <span className="rd-sr">{failed ? "failed" : state === "done" ? "done" : state === "active" ? "running" : "waiting"}</span> {labels[key]}
                </li>
              );
            })}
          </ol>
          {failure !== undefined && (
            <div className="repo-note rd-failure" role="alert">
              <p className="rd-failure-title">
                <StatusMark status="failed" />{" "}
                {TEXT.stepFailed[failure.phase]}
              </p>
              <p>
                {failure.message}
                {failure.phase === "commit" && ` ${left === "" ? "Nothing in the folder changed." : TEXT.folderNow(left)}`}
              </p>
              <Button variant="link" className="rd-link" onClick={() => void setUp()}>
                {TEXT.tryAgain}
              </Button>
            </div>
          )}
        </DialogFrame>
      </Modal>
    );
  }

  const checksHint = hadChecks && suggestion !== undefined ? `${TEXT.checksFound(suggestion.checksFrom.join(", "))} ${TEXT.checksHint}` : TEXT.checksHint;
  const choices = editing ? editBranches : suggestion;
  const listed = choices?.branches ?? [];
  const toOption = (entry: (typeof listed)[number]) => ({ value: entry.name, tag: entry.group === "default" ? TEXT.defaultTag : undefined });
  const upper = listed.filter((entry) => entry.group !== "other").map(toOption);
  const lower = listed.filter((entry) => entry.group === "other").map(toOption);
  const branchGroups: ComboboxGroup[] = [{ options: upper }, { heading: upper.length > 0 ? TEXT.otherBranches : undefined, options: lower }];
  const moreBranches = choices?.moreBranches ?? 0;
  const branchFooter = [...(moreBranches > 0 ? [TEXT.branchesCut(listed.length, listed.length + moreBranches)] : []), TEXT.typeBranch, TEXT.branchKeys];
  const shortHints = !editing && lines.length === 0;
  const idField = (
    <Field label={TEXT.id} hint={editing ? TEXT.idFixed : shortHints ? TEXT.idFromFolder : `${TEXT.idHint} ${TEXT.idFromFolder}`}>
      {(props) =>
        editing ? (
          <span className="rd-fixed-box">
            <input {...props} className="mono rd-fixed" value={id} readOnly />
            <span className="rd-dim">{TEXT.readOnly}</span>
          </span>
        ) : (
          <input {...props} className="mono" value={id} placeholder="orders-api" onChange={(event) => setId(event.target.value)} autoFocus spellCheck={false} autoComplete="off" />
        )
      }
    </Field>
  );
  const branchField = (
    <Field label={TEXT.baseBranch} hint={editing ? TEXT.baseBranchEditHint : listed.length === 1 ? TEXT.baseBranchOnlyHint : TEXT.baseBranchHint}>
      {(props, labelId) => (
        <Combobox
          id={props.id}
          labelledBy={labelId}
          describedBy={props["aria-describedby"]}
          value={baseBranch}
          valueTag={baseBranch !== "" && baseBranch === choices?.defaultBranch ? TEXT.defaultTag : undefined}
          placeholder="main"
          groups={branchGroups}
          listLabel={TEXT.branches}
          searchLabel={TEXT.searchBranches}
          searchPlaceholder={TEXT.searchBranchesPlaceholder}
          freeText={{ label: TEXT.useBranch }}
          footer={branchFooter}
          mono
          autoFocus={editing}
          onChange={setBaseBranch}
        />
      )}
    </Field>
  );
  const checksField = (
    <Field
      label={TEXT.checks}
      hint={lines.length === 0 && !editing ? "" : editing ? TEXT.checksHint : checksHint}
      after={
        helpersOffered && !suggestInBox ? (
          <ChecksHelpersRow h={helpers} lines={lines} onAdd={addChecks} baseBranch={baseBranch} editing={editing} onOpenGetStarted={onOpenGetStarted} />
        ) : undefined
      }
      tag={editing ? undefined : hadChecks ? <span className="rd-suggested"><span aria-hidden="true">{markOf("passed").symbol} </span>{TEXT.suggested}</span> : <span className="rd-dim">{TEXT.noneFound}</span>}
    >
      {(props) => <textarea {...props} className="mono" rows={3} value={checks} placeholder={"npm test\nnode --check src/main.js"} onChange={(event) => setChecks(event.target.value)} spellCheck={false} />}
    </Field>
  );
  const noChecks = lines.length === 0 && (
    <div className="repo-note">
      <p className="rd-note-title">{TEXT.noChecks}</p>
      <p>{TEXT.noChecksWhy}</p>
      {fallback !== null && !editing && (
        <p className="rd-fallback">
          <Button variant="secondary" onClick={() => setChecks(fallback)}>
            Use <span className="mono">{fallback}</span>
          </Button>
          {suggestion?.fallbackFromPackage === true && <span className="rd-dim">{TEXT.fromPackageMain(fallback.replace(/^node --check /, ""))}</span>}
        </p>
      )}
      {suggestInBox && <SuggestInBox h={helpers} onOpenGetStarted={onOpenGetStarted} />}
    </div>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (!editing && loaded === undefined) {
    body = <p role="status">{TEXT.reading}</p>;
    footer = (
      <>
        {cancel}
        <Button variant="primary" type="submit" disabled>
          {TEXT.add}
        </Button>
      </>
    );
  } else if (loaded?.ok === false) {
    body = <Problem text={loaded.message} />;
    footer = (
      <>
        {cancel}
        <Button variant="primary" type="submit" disabled>
          {TEXT.add}
        </Button>
      </>
    );
  } else if (refused !== null && suggestion !== undefined) {
    // Refused: the home folder or too many files. The primary button stays, off, so the way is clear.
    body = (
      <p className="rd-refusal">
        <span aria-hidden="true">! </span>
        {refused}
      </p>
    );
    footer = (
      <>
        {onPickAnother !== undefined && (
          <Button variant="secondary" onClick={onPickAnother}>
            {TEXT.pickAnother}
          </Button>
        )}
        <Button variant="primary" aria-disabled="true" disabled>
          {suggestion.gitRepo ? TEXT.firstCommit : TEXT.setUpGit}
        </Button>
      </>
    );
  } else if (settingUp && suggestion !== undefined && firstCommit !== null) {
    const rest = firstCommit.files - firstCommit.sample.length;
    body = (
      <>
        {suggestion.gitRepo ? (
          <p className="rd-lead-text">
            {TEXT.noCommits} <span className="mono">{branchName}</span>.
          </p>
        ) : (
          <>
            <div className="rd-lead">
              <span className="rd-lead-title">{TEXT.notARepo}</span>
              <span className="rd-sub">{TEXT.setUpIntro}</span>
            </div>
            <ol className="rd-list">
              <li>
                <span className="mono">git init</span> <span className="rd-dim">{TEXT.gitInitOn}</span> <span className="mono">{branchName}</span>
              </li>
              {firstCommit.addsGitignore && (
                <li>
                  <span className="rd-dim">writes a</span> <span className="mono">.gitignore</span> <span className="rd-dim">{TEXT.writesGitignore}</span>
                </li>
              )}
              <li>
                <span className="rd-dim">{TEXT.makesCommit}</span> <span className="mono">Initial commit</span>
              </li>
            </ol>
          </>
        )}
        <div className="rd-commit">
          <div className="rd-commit-head">
            <span>{TEXT.firstCommitHeading}</span>
            <span className="mono rd-dim">
              {plural(firstCommit.files, "file")} · {size(firstCommit.bytes)}
              {!firstCommit.addsGitignore && ` · ${TEXT.existingGitignore}`}
            </span>
          </div>
          <ul className="rd-files mono">
            {firstCommit.sample.map((file) => (
              <li key={file.path}>
                <span className="rd-plus" aria-hidden="true">
                  +
                </span>
                <span className="rd-path">{file.path}</span>
                <span className="rd-dim">{size(file.bytes)}</span>
              </li>
            ))}
            {rest > 0 && (
              <li className="rd-dim">
                {TEXT.more(rest)}
                {firstCommit.more.length > 0 && ` · ${firstCommit.more.join(", ")}`}
              </li>
            )}
          </ul>
        </div>
        {firstCommit.leftOut.length > 0 && (
          <div className="rd-left-out">
            <span>{TEXT.leftOut}</span>
            <span className="mono rd-dim">
              {firstCommit.leftOut.map((entry) => (entry.files !== null && entry.files > 1 ? `${entry.name} (${plural(entry.files, "file")})` : entry.files === null ? `${entry.name} (${TEXT.manyFiles})` : entry.name)).join(" · ")}
            </span>
            {firstCommit.leftOut.some((entry) => entry.name.startsWith(".env")) && <span className="rd-dim">{TEXT.leftOutNote}</span>}
          </div>
        )}
        {idField}
        {suggestion.gitRepo && checksField}
        {suggestion.gitRepo && noChecks}
        {error !== undefined && <Problem text={error} alert />}
      </>
    );
    footer = (
      <>
        {cancel}
        <Button variant="primary" disabled={busy} onClick={() => void setUp()}>
          {suggestion.gitRepo ? TEXT.firstCommit : TEXT.setUpGit}
        </Button>
      </>
    );
  } else if (!editing && suggestion !== undefined && suggestion.problem !== null) {
    // Something else is wrong with the folder: it is named, and Add stays off.
    body = <Problem text={suggestion.problem} />;
    footer = (
      <>
        {cancel}
        <Button variant="primary" type="submit" disabled>
          {TEXT.add}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {idField}
        {branchField}
        {checksField}
        {noChecks}
        {error !== undefined && <Problem text={error} alert />}
      </>
    );
    footer = (
      <>
        {cancel}
        <Button variant="primary" type="submit" disabled={busy || !canAdd}>
          {editing ? (busy ? TEXT.saving : TEXT.save) : busy ? TEXT.adding : TEXT.add}
        </Button>
      </>
    );
  }

  return (
    <Modal labelledBy={titleId} onClose={close}>
      <form className="repo-form" onSubmit={(event) => void submit(event)}>
        <DialogFrame titleId={titleId} title={editing ? TEXT.editTitle : TEXT.title} subtitle={editing ? undefined : (suggestion?.displayPath ?? path)} onClose={close} footer={footer}>
          {body}
        </DialogFrame>
      </form>
    </Modal>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint: string;
  /** Next to the label, such as "✓ suggested". */
  readonly tag?: ReactNode | undefined;
  /** Under the hint, still part of the field: the checks helpers. */
  readonly after?: ReactNode | undefined;
  /** Gets the props of the control, and the id of the label, for a control that names itself from it. */
  readonly children: (props: { id: string; "aria-describedby": string }, labelId: string) => ReactNode;
}

function Field({ label, hint, tag, after, children }: FieldProps) {
  const id = useId();
  return (
    <div className="repo-field">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
        {tag !== undefined && <span className="rd-tag">{tag}</span>}
      </label>
      {children({ id, "aria-describedby": `${id}-hint` }, `${id}-label`)}
      {hint !== "" && (
        <span id={`${id}-hint`} className="repo-hint">
          {hint}
        </span>
      )}
      {after}
    </div>
  );
}
