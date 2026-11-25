// The repo dialog. Add: after the folder picker, the engine's suggestions for the folder (id, base
// branch, checks) as editable fields, then Add. Edit: from a repo row's menu, the repo's current
// base branch and checks, with its id fixed, then Save. The engine checks every field again and
// answers a refusal in plain words, shown here. Engine text is rendered as React text only.
import type { RepoSummary, SuggestRepoResult } from "@tokama/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Modal, Problem } from "./Modal.js";

const TEXT = {
  title: "Add repo",
  editTitle: "Edit repo",
  reading: "Reading the folder…",
  id: "Id",
  idHint: "How Tokama names the repo: lowercase letters, digits and hyphens.",
  idFixed: "The id can't be changed. To use another one, remove the repo and add it again.",
  baseBranch: "Base branch",
  baseBranchHint: "Work branches start from it.",
  checks: "Checks",
  checksHint: "One command per line, run in the repo to check each change. No &&, | or redirects.",
  add: "Add repo",
  adding: "Adding…",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  failed: (message: string) => `Could not add it: ${message}`,
  saveFailed: (message: string) => `Could not save it: ${message}`,
  noChecks: "No checks yet.",
  noChecksWhy: "Tokama runs checks after the agent's change, to see whether it still works. Quick fix and Plan and build need at least one; templates where you approve the change work without checks.",
  fallback: (command: string) => `This folder has no package.json. If it is a plain JavaScript project, ${command} at least checks that its entry file parses.`,
  useFallback: (command: string) => `Use ${command}`,
  setUpGit: "Set up git and add",
  firstCommit: "Make a first commit and add",
  firstCommitFiles: (files: number) => `The first commit will hold ${files} ${files === 1 ? "file" : "files"}:`,
  firstCommitMore: (rest: number) => `…and ${rest} more`,
  addsGitignore: "Tokama also adds a .gitignore that leaves out .DS_Store, node_modules/, .env*, dist/ and build/.",
  setUpFailed: (message: string) => `Could not set up git: ${message}`,
} as const;

export type RepoDialogProps = {
  readonly bridge: TokamaBridge;
  readonly onClose: () => void;
} & (
  | { /** The folder the picker returned: adds a repo. */ readonly path: string; readonly repo?: undefined }
  | { /** The repo to change: edits it. */ readonly repo: RepoSummary; readonly path?: undefined }
);

type Loaded = { readonly ok: true; readonly suggestion: SuggestRepoResult } | { readonly ok: false; readonly message: string };

export function RepoDialog({ bridge, path, repo, onClose }: RepoDialogProps) {
  const titleId = useId();
  const editing = repo !== undefined;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [id, setId] = useState(repo?.id ?? "");
  const [baseBranch, setBaseBranch] = useState(repo?.baseBranch ?? "");
  const [checks, setChecks] = useState(repo?.checks.join("\n") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    void bridge
      .query({ type: "suggest_repo", path })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }))
      .then((reply) => {
        if (!live) return;
        if (!reply.ok) return setLoaded({ ok: false, message: reply.error.message });
        setLoaded({ ok: true, suggestion: reply.data });
        setId(reply.data.id ?? "");
        setBaseBranch(reply.data.branch ?? (reply.data.firstCommit === null ? "" : "main"));
        setChecks(reply.data.checks.join("\n"));
      });
    return () => {
      live = false;
    };
  }, [bridge, path]);

  const suggestion = loaded?.ok ? loaded.suggestion : undefined;
  const firstCommit = suggestion?.firstCommit ?? null;
  const ready = editing || (suggestion !== undefined && (suggestion.problem === null || (firstCommit !== null && firstCommit.refusal === null)));
  const canAdd = editing || (suggestion !== undefined && suggestion.problem === null);
  const lines = checks.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const fallback = suggestion?.fallbackCheck ?? null;
  const submit = async (event: FormEvent, setUp = false) => {
    event.preventDefault();
    if (!ready || busy || (!canAdd && !setUp)) return;
    setBusy(true);
    setError(undefined);
    if (setUp && suggestion !== undefined) {
      const done = await bridge
        .command({ type: "init_repo", path: suggestion.path, ...(baseBranch.trim() === "" || suggestion.gitRepo ? {} : { baseBranch: baseBranch.trim() }) })
        .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
      if (!done.ok) {
        setBusy(false);
        setError(TEXT.setUpFailed(done.error.message));
        return;
      }
    }
    const reply = await bridge
      .command(
        repo !== undefined
          ? { type: "update_repo", repoId: repo.id, baseBranch: baseBranch.trim(), checks: lines }
          : {
              type: "add_repo",
              path: suggestion!.path,
              ...(id.trim() === "" ? {} : { id: id.trim() }),
              ...(baseBranch.trim() === "" ? {} : { baseBranch: baseBranch.trim() }),
              checks: lines,
            },
      )
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    setBusy(false);
    if (reply.ok) onClose();
    else setError((editing ? TEXT.saveFailed : TEXT.failed)(reply.error.message));
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <form className="repo-form" onSubmit={(event) => void submit(event)}>
        <h2 id={titleId} className="modal-title">
          {editing ? TEXT.editTitle : TEXT.title}
        </h2>
        {!editing && <p className="repo-path mono">{suggestion?.path ?? path}</p>}
        {!editing && loaded === undefined && <p role="status">{TEXT.reading}</p>}
        {loaded?.ok === false && <Problem text={loaded.message} />}
        {suggestion?.problem != null && <Problem text={suggestion.problem} />}
        {firstCommit?.refusal != null && <Problem text={firstCommit.refusal} />}
        {ready && (
          <>
            <Field label={TEXT.id} hint={editing ? TEXT.idFixed : TEXT.idHint}>
              {(props) => (
                <input {...props} className="mono" value={id} readOnly={editing} onChange={(event) => setId(event.target.value)} autoFocus={!editing} spellCheck={false} autoComplete="off" />
              )}
            </Field>
            <Field label={TEXT.baseBranch} hint={TEXT.baseBranchHint}>
              {(props) => <input {...props} className="mono" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} autoFocus={editing} spellCheck={false} autoComplete="off" />}
            </Field>
            <Field label={TEXT.checks} hint={TEXT.checksHint}>
              {(props) => <textarea {...props} className="mono" rows={3} value={checks} onChange={(event) => setChecks(event.target.value)} spellCheck={false} />}
            </Field>
            {firstCommit !== null && firstCommit.refusal === null && (
              <div className="repo-note">
                <p>{TEXT.firstCommitFiles(firstCommit.files)}</p>
                <ul className="mono">
                  {firstCommit.sample.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
                {firstCommit.files > firstCommit.sample.length && <p>{TEXT.firstCommitMore(firstCommit.files - firstCommit.sample.length)}</p>}
                {firstCommit.addsGitignore && <p>{TEXT.addsGitignore}</p>}
              </div>
            )}
            {lines.length === 0 && (
              <div className="repo-note">
                <p>
                  <strong>{TEXT.noChecks}</strong> {TEXT.noChecksWhy}
                </p>
                {fallback !== null && (
                  <>
                    <p>{TEXT.fallback(fallback)}</p>
                    <button type="button" className="choice mono" onClick={() => setChecks(fallback)}>
                      {TEXT.useFallback(fallback)}
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {error !== undefined && <Problem text={error} alert />}
        <div className="choices">
          <button type="submit" className="choice primary" disabled={busy || !canAdd}>
            {editing ? (busy ? TEXT.saving : TEXT.save) : busy ? TEXT.adding : TEXT.add}
          </button>
          {firstCommit !== null && firstCommit.refusal === null && (
            <button type="button" className="choice" disabled={busy} onClick={(event) => void submit(event, true)}>
              {suggestion?.gitRepo ? TEXT.firstCommit : TEXT.setUpGit}
            </button>
          )}
          <button type="button" className="choice" onClick={onClose}>
            {TEXT.cancel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint: string;
  readonly children: (props: { id: string; "aria-describedby": string }) => React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div className="repo-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": `${id}-hint` })}
      <span id={`${id}-hint`} className="repo-hint">
        {hint}
      </span>
    </div>
  );
}
